import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID } from "./schema"
import { QuestionID } from "@/question/schema"

export namespace SessionBlocker {
  export const TerminalReason = z.enum(["replied", "cancelled", "dismissed", "shutdown", "rejected"])
  export type TerminalReason = z.infer<typeof TerminalReason>
  export type CleanupReason = TerminalReason | "session_deleted" | "session_archived" | "dangling_session"

  export const QuestionRequest = z.object({
    id: QuestionID.zod,
    sessionID: SessionID.zod,
    questions: z.array(
      z.object({
        question: z.string(),
        header: z.string(),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string(),
          }),
        ),
        multiple: z.boolean().optional(),
        custom: z.boolean().optional(),
      }),
    ),
    tool: z
      .object({
        messageID: MessageID.zod,
        callID: z.string(),
      })
      .optional(),
  })
  export type QuestionRequest = z.infer<typeof QuestionRequest>

  export const Entry = z.object({
    kind: z.literal("question"),
    status: z.literal("awaiting_user"),
    sessionID: SessionID.zod,
    requestID: QuestionID.zod,
    request: QuestionRequest,
    tool: QuestionRequest.shape.tool,
    armedAt: z.number(),
    updatedAt: z.number(),
  })
  export type Entry = z.infer<typeof Entry>

  export const Removed = z.object({
    kind: z.literal("question"),
    sessionID: SessionID.zod,
    requestID: QuestionID.zod,
    reason: TerminalReason,
  })

  export const Event = {
    Upserted: BusEvent.define("session.blocker.upserted", Entry),
    Removed: BusEvent.define("session.blocker.removed", Removed),
  }

  const questionByDirectory = new Map<string, Map<QuestionID, Entry>>()

  function questionState(directory: string) {
    let state = questionByDirectory.get(directory)
    if (!state) {
      state = new Map<QuestionID, Entry>()
      questionByDirectory.set(directory, state)
    }
    return state
  }

  export interface Interface {
    readonly upsertQuestion: (request: QuestionRequest) => Effect.Effect<void>
    readonly removeQuestion: (input: { requestID: QuestionID; reason: TerminalReason }) => Effect.Effect<void>
    readonly clearSession: (sessionID: SessionID, reason: CleanupReason) => Effect.Effect<void>
    readonly list: () => Effect.Effect<ReadonlyArray<Entry>>
    readonly hasAwaitingQuestion: (sessionID: SessionID) => Effect.Effect<boolean>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionBlocker") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      const upsertQuestion = Effect.fn("SessionBlocker.upsertQuestion")(function* (request: QuestionRequest) {
        const pending = questionState(yield* InstanceState.directory)
        const now = Date.now()
        const existing = pending.get(request.id)
        const entry: Entry = {
          kind: "question",
          status: "awaiting_user",
          sessionID: request.sessionID,
          requestID: request.id,
          request: structuredClone(request),
          tool: request.tool ? structuredClone(request.tool) : undefined,
          armedAt: existing?.armedAt ?? now,
          updatedAt: now,
        }
        pending.set(request.id, entry)
        yield* bus.publish(Event.Upserted, structuredClone(entry))
      })

      const removeQuestion = Effect.fn("SessionBlocker.removeQuestion")(function* (input: {
        requestID: QuestionID
        reason: TerminalReason
      }) {
        const pending = questionState(yield* InstanceState.directory)
        const existing = pending.get(input.requestID)
        if (!existing) return
        pending.delete(input.requestID)
        yield* bus.publish(Event.Removed, {
          kind: "question",
          sessionID: existing.sessionID,
          requestID: existing.requestID,
          reason: input.reason,
        })
      })

      const clearReason = (reason: CleanupReason): TerminalReason => {
        if (reason === "session_deleted" || reason === "session_archived" || reason === "dangling_session")
          return "shutdown"
        return reason
      }

      const clearSession = Effect.fn("SessionBlocker.clearSession")(function* (
        sessionID: SessionID,
        reason: CleanupReason,
      ) {
        const pending = questionState(yield* InstanceState.directory)
        const terminalReason = clearReason(reason)
        for (const entry of Array.from(pending.values())) {
          if (entry.sessionID !== sessionID) continue
          pending.delete(entry.requestID)
          yield* bus.publish(Event.Removed, {
            kind: "question",
            sessionID: entry.sessionID,
            requestID: entry.requestID,
            reason: terminalReason,
          })
        }
      })

      const list = Effect.fn("SessionBlocker.list")(function* () {
        const pending = questionState(yield* InstanceState.directory)
        return Array.from(pending.values(), (entry) => structuredClone(entry))
      })

      const hasAwaitingQuestion = Effect.fn("SessionBlocker.hasAwaitingQuestion")(function* (sessionID: SessionID) {
        const pending = questionState(yield* InstanceState.directory)
        for (const entry of pending.values()) {
          if (entry.sessionID === sessionID && entry.status === "awaiting_user") return true
        }
        return false
      })

      return Service.of({ upsertQuestion, removeQuestion, clearSession, list, hasAwaitingQuestion })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
}
