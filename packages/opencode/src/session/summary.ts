import z from "zod"
import { Effect, Layer, Context } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Snapshot } from "@/snapshot"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { sanitizeSensitiveDiffs } from "@/tool/sensitive"
import { TurnChange, type TurnChangeAggregate } from "./turn-change"

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

  export interface Interface {
    readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
    readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<TurnChangeAggregate>
    readonly artifacts: (input: { sessionID: SessionID }) => Effect.Effect<Artifact[]>
    readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const turnChange = yield* TurnChange.Service

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

      const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
        if (input.messageID)
          return yield* turnChange.aggregateTurnUnion({ sessionID: input.sessionID, userMessageID: input.messageID })
        return yield* turnChange.aggregateSessionFromTurns({ sessionID: input.sessionID })
      })

      const summarize = Effect.fn("SessionSummary.summarize")(function* (_input: {
        sessionID: SessionID
        messageID: MessageID
      }) {})

      const artifacts = Effect.fn("SessionSummary.artifacts")(function* (input: { sessionID: SessionID }) {
        const aggregate = yield* turnChange.aggregateSessionFromTurns({ sessionID: input.sessionID })
        const result = new Map<string, Artifact>()
        if (aggregate.kind !== "captured" && aggregate.kind !== "mixed") return []
        for (const file of aggregate.files) {
          if (file.restoreState !== "applied") continue
          if (file.status !== "added" && file.status !== "modified") continue
          if (result.has(file.path)) continue
          result.set(file.path, { file: file.path, kind: file.status })
        }
        return Array.from(result.values())
      })

      return Service.of({ summarize, diff, artifacts, computeDiff })
    }),
  )

  export const defaultLayer: Layer.Layer<Service, never, never> = Layer.suspend(() =>
    layer.pipe(Layer.provide(Snapshot.defaultLayer), Layer.provide(TurnChange.defaultLayer)),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const summarize = (_input: { sessionID: SessionID; messageID: MessageID }) => undefined

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
