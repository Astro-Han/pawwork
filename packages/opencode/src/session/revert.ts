import z from "zod"
import { Effect, Layer, Context, Option, Semaphore } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { SyncEvent } from "../sync"
import { Log } from "@opencode-ai/core/util/log"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"

const log = Log.create({ service: "session.revert" })

export const RevertInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod,
  partID: PartID.zod.optional(),
})
export type RevertInput = z.infer<typeof RevertInput>
export const UnrevertInput = z.object({
  sessionID: SessionID.zod,
})

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
  readonly cleanupBefore: <A, E, R>(
    sessionID: SessionID,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly cleanupBeforeOrBusy: <A, E, R>(
    sessionID: SessionID,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const bus = yield* Bus.Service
    const state = yield* SessionRunState.Service
    const locks = new Map<SessionID, { semaphore: Semaphore.Semaphore; users: number }>()

    const trackMutationLock = (sessionID: SessionID) => {
      const entry = locks.get(sessionID) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 }
      entry.users += 1
      locks.set(sessionID, entry)
      const release = Effect.sync(() => {
        entry.users -= 1
        if (entry.users === 0 && locks.get(sessionID) === entry) locks.delete(sessionID)
      })
      return { entry, release }
    }
    const withMutationLock = <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const { entry, release } = trackMutationLock(sessionID)
        return entry.semaphore.withPermits(1)(work).pipe(Effect.ensuring(release))
      })
    const withMutationLockOrBusy = <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const { entry, release } = trackMutationLock(sessionID)
        return entry.semaphore.withPermitsIfAvailable(1)(work).pipe(
          Effect.ensuring(release),
          Effect.flatMap((result) => {
            if (Option.isSome(result)) return Effect.succeed(result.value)
            throw new Session.BusyError(sessionID)
          }),
        )
      })

    function revertSummary(diff: string | undefined) {
      if (!diff) return { additions: 0, deletions: 0, files: 0 }
      const files = new Set<string>()
      let additions = 0
      let deletions = 0
      let currentFile: string | undefined
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
          const match = line.match(/.*\s"b\/([^"\\]*(?:\\.[^"\\]*)*)"$/) ?? line.match(/.*\sb\/(.+)$/)
          currentFile = match?.[1]?.replace(/"$/, "").trim()
          if (currentFile) files.add(currentFile)
          continue
        }
        if (line.startsWith("+++") || line.startsWith("---")) continue
        if (line.startsWith("+")) additions++
        if (line.startsWith("-")) deletions++
      }
      return { additions, deletions, files: files.size }
    }

    const revertMutation = Effect.fn("SessionRevert.revertMutation")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID })
      let lastUser: MessageV2.User | undefined
      const session = yield* sessions.get(input.sessionID)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot as string)
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: revertSummary(rev.diff),
      })
      yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: input.sessionID })
      return yield* sessions.get(input.sessionID)
    })
    const revert = Effect.fn("SessionRevert.revert")((input: RevertInput) =>
      withMutationLock(input.sessionID, revertMutation(input)),
    )

    const unrevertMutation = Effect.fn("SessionRevert.unrevertMutation")(function* (input: {
      sessionID: SessionID
    }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert!.snapshot!)
      yield* sessions.clearRevert(input.sessionID)
      yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: input.sessionID })
      return yield* sessions.get(input.sessionID)
    })
    const unrevert = Effect.fn("SessionRevert.unrevert")((input: { sessionID: SessionID }) =>
      withMutationLock(input.sessionID, unrevertMutation(input)),
    )

    const cleanupMutation = Effect.fn("SessionRevert.cleanupMutation")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID)
      if (!session.revert) return
      const msgs = yield* sessions.messages({ sessionID })
      const messageID = session.revert.messageID
      const targetIndex = msgs.findIndex((msg) => msg.info.id === messageID)
      if (targetIndex < 0) {
        log.warn("clearing stale revert with missing boundary", { sessionID, messageID })
        yield* sessions.clearRevert(sessionID)
        yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID })
        return
      }
      const target = session.revert.partID ? msgs[targetIndex] : undefined
      const remove = msgs.slice(session.revert.partID ? targetIndex + 1 : targetIndex)
      // Keep the persisted boundary until its tail is gone so interrupted cleanup can resume.
      for (const msg of remove.reverse()) {
        SyncEvent.run(MessageV2.Event.Removed, {
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts.reverse()) {
            SyncEvent.run(MessageV2.Event.PartRemoved, {
              sessionID,
              messageID: target.info.id,
              partID: part.id,
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
      yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID })
    })
    const cleanup = Effect.fn("SessionRevert.cleanup")((session: Session.Info) =>
      withMutationLock(session.id, cleanupMutation(session.id)),
    )
    const cleanupBefore: Interface["cleanupBefore"] = (sessionID, work) =>
      withMutationLock(sessionID, cleanupMutation(sessionID).pipe(Effect.andThen(work)))
    const cleanupBeforeOrBusy: Interface["cleanupBeforeOrBusy"] = (sessionID, work) =>
      withMutationLockOrBusy(sessionID, cleanupMutation(sessionID).pipe(Effect.andThen(work)))

    return Service.of({ revert, unrevert, cleanup, cleanupBefore, cleanupBeforeOrBusy })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export * as SessionRevert from "./revert"
