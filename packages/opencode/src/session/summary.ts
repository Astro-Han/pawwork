import z from "zod"
import { Effect, Layer, Context } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"

export namespace SessionSummary {
  export const Artifact = z
    .object({
      file: z.string(),
      kind: z.enum(["added", "modified"]),
    })
    .meta({
      ref: "SessionArtifact",
    })
  export type Artifact = z.infer<typeof Artifact>

  function unquoteGitPath(input: string) {
    if (!input.startsWith('"')) return input
    if (!input.endsWith('"')) return input
    const body = input.slice(1, -1)
    const bytes: number[] = []

    for (let i = 0; i < body.length; i++) {
      const char = body[i]!
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0))
        continue
      }

      const next = body[i + 1]
      if (!next) {
        bytes.push("\\".charCodeAt(0))
        continue
      }

      if (next >= "0" && next <= "7") {
        const chunk = body.slice(i + 1, i + 4)
        const match = chunk.match(/^[0-7]{1,3}/)
        if (!match) {
          bytes.push(next.charCodeAt(0))
          i++
          continue
        }
        bytes.push(parseInt(match[0], 8))
        i += match[0].length
        continue
      }

      const escaped =
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next === "\\" || next === '"'
                      ? next
                      : undefined

      bytes.push((escaped ?? next).charCodeAt(0))
      i++
    }

    return Buffer.from(bytes).toString()
  }

  export interface Interface {
    readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
    readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
    readonly artifacts: (input: { sessionID: SessionID }) => Effect.Effect<Artifact[]>
    readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const snapshot = yield* Snapshot.Service
      const storage = yield* Storage.Service
      const bus = yield* Bus.Service

      const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: {
        messages: MessageV2.WithParts[]
      }) {
        let from: string | undefined
        let to: string | undefined
        for (const item of input.messages) {
          if (!from) {
            for (const part of item.parts) {
              if (part.type === "step-start" && part.snapshot) {
                from = part.snapshot
                break
              }
            }
          }
          for (const part of item.parts) {
            if (part.type === "step-finish" && part.snapshot) to = part.snapshot
          }
        }
        if (from && to) return yield* snapshot.diffFull(from, to)
        return []
      })

      const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
        sessionID: SessionID
        messageID: MessageID
      }) {
        const all = yield* sessions.messages({ sessionID: input.sessionID })
        if (!all.length) return

        const diffs = yield* computeDiff({ messages: all })
        yield* sessions.setSummary({
          sessionID: input.sessionID,
          summary: {
            additions: diffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            files: diffs.length,
          },
        })
        yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
        yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })

        const messages = all.filter(
          (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
        )
        const target = messages.find((m) => m.info.id === input.messageID)
        if (!target || target.info.role !== "user") return
        const msgDiffs = yield* computeDiff({ messages })
        target.info.summary = { ...target.info.summary, diffs: msgDiffs }
        yield* sessions.updateMessage(target.info)
      })

      const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
        const diffs = yield* storage
          .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
          .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
        const next = diffs.map((item) => {
          const file = unquoteGitPath(item.file)
          if (file === item.file) return item
          return { ...item, file }
        })
        const changed = next.some((item, i) => item.file !== diffs[i]?.file)
        if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
        return next
      })

      const artifacts = Effect.fn("SessionSummary.artifacts")(function* (input: { sessionID: SessionID }) {
        const messages = yield* sessions.messages({ sessionID: input.sessionID })
        const result = new Map<string, Artifact>()

        for (const message of messages) {
          if (message.info.role !== "user") continue
          const diffs = message.info.summary?.diffs ?? []
          for (const diff of diffs) {
            if (diff.status !== "added" && diff.status !== "modified") continue
            const file = unquoteGitPath(diff.file)
            if (result.has(file)) continue
            result.set(file, {
              file,
              kind: diff.status,
            })
          }
        }

        if (result.size === 0) {
          const current = yield* diff({ sessionID: input.sessionID })
          for (const item of current) {
            if (item.status !== "added" && item.status !== "modified") continue
            const file = unquoteGitPath(item.file)
            if (result.has(file)) continue
            result.set(file, { file, kind: item.status })
          }
        }

        return Array.from(result.values())
      })

      return Service.of({ summarize, diff, artifacts, computeDiff })
    }),
  )

  export const defaultLayer: Layer.Layer<Service, never, never> = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(Snapshot.defaultLayer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Bus.layer),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const summarize = (input: { sessionID: SessionID; messageID: MessageID }) =>
    void runPromise((svc) => svc.summarize(input)).catch(() => {})

  export const DiffInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
  })

  export const ArtifactsInput = z.object({
    sessionID: SessionID.zod,
  })

  export async function diff(input: z.infer<typeof DiffInput>) {
    return runPromise((svc) => svc.diff(input))
  }

  export async function artifacts(input: z.infer<typeof ArtifactsInput>) {
    return runPromise((svc) => svc.artifacts(input))
  }
}
