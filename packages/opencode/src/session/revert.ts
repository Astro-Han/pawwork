import z from "zod"
import { Effect, Layer, Context } from "effect"
import { makeRuntime } from "@/effect/run-service"
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const bus = yield* Bus.Service
    const state = yield* SessionRunState.Service

    function revertSummary(diff: string | undefined) {
      if (!diff) return { additions: 0, deletions: 0, files: 0 }
      const files = new Set<string>()
      let additions = 0
      let deletions = 0
      let currentFile: string | undefined
      for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
          currentFile = line.split(" b/")[1]?.trim()
          if (currentFile) files.add(currentFile)
          continue
        }
        if (line.startsWith("+++") || line.startsWith("---")) continue
        if (line.startsWith("+")) additions++
        if (line.startsWith("-")) deletions++
      }
      return { additions, deletions, files: files.size }
    }

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
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

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert!.snapshot!)
      yield* sessions.clearRevert(input.sessionID)
      yield* bus.publish(Session.Event.TurnChangeInvalidated, { sessionID: input.sessionID })
      return yield* sessions.get(input.sessionID)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID })
      const messageID = session.revert.messageID
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
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
          for (const part of removeParts) {
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

    return Service.of({ revert, unrevert, cleanup })
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

const { runPromise } = makeRuntime(Service, defaultLayer)

export const revert = (input: RevertInput) => runPromise((svc) => svc.revert(RevertInput.parse(input)))
export const unrevert = (input: z.infer<typeof UnrevertInput>) =>
  runPromise((svc) => svc.unrevert(UnrevertInput.parse(input)))
export const cleanup = (session: Session.Info) => runPromise((svc) => svc.cleanup(Session.Info.parse(session)))

export * as SessionRevert from "./revert"
