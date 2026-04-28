import { Context, Effect, Layer, Semaphore } from "effect"
import { Bus } from "../bus"
import * as Session from "./session"
import { PartID as PartIDNs, type MessageID, type PartID, type SessionID } from "./schema"
import type { MessageV2 } from "./message-v2"
import type { ProviderID, ModelID } from "../provider/schema"
import { SubagentRunWriterContext } from "./subagent-run-context"

export class TooManyActive {
  readonly _tag = "TooManyActive"
  constructor(readonly parentID: SessionID) {}
}

export class NotFound {
  readonly _tag = "NotFound"
  constructor(readonly key: string) {}
}

export type TerminalStatus = "completed" | "completed_empty" | "failed" | "canceled_by_user"
export type AgentListFilter = TerminalStatus | "running" | "all_active" | "all"

export interface StartInput {
  parent_session_id: SessionID
  parent_message_id: MessageID
  tool_call_id: string
  description: string
  prompt: string
  agent: string
  subagent_type: string
  command?: string
  model?: { providerID: ProviderID; modelID: ModelID }
}

export interface FinalizeFields {
  result_text?: string
  result_summary?: string
  partial_result?: string | null
  error?: { kind: string; message: string }
  ended_at?: number
}

export interface RejectedInput {
  parent_session_id: SessionID
  parent_message_id: MessageID
  tool_call_id: string
  description: string
  prompt: string
  agent: string
  subagent_type: string
  command?: string
  model?: { providerID: ProviderID; modelID: ModelID }
  reason: string
}

export interface Interface {
  readonly reserveSlot: (parentID: SessionID) => Effect.Effect<void, TooManyActive>
  readonly releaseSlot: (parentID: SessionID) => Effect.Effect<void>
  readonly start: (input: StartInput) => Effect.Effect<MessageV2.SubtaskPart>
  readonly patchSession: (toolCallID: string, sessionID: SessionID) => Effect.Effect<void>
  readonly recordEvent: (toolCallID: string, event: MessageV2.SubtaskEvent) => Effect.Effect<void>
  readonly recordActivity: (
    toolCallID: string,
    activity: NonNullable<MessageV2.SubtaskPart["last_activity"]>,
  ) => Effect.Effect<void>
  readonly finalize: (
    toolCallID: string,
    status: TerminalStatus,
    fields: FinalizeFields,
  ) => Effect.Effect<void>
  readonly recordRejected: (input: RejectedInput) => Effect.Effect<MessageV2.SubtaskPart>
  readonly setConsumed: (toolCallID: string) => Effect.Effect<void>
  readonly read: (toolCallID: string) => Effect.Effect<MessageV2.SubtaskPart, NotFound>
  readonly findLatestBySessionID: (
    parentID: SessionID,
    subagentSessionID: SessionID,
  ) => Effect.Effect<MessageV2.SubtaskPart, NotFound>
  readonly list: (
    parentID: SessionID,
    filter: { status: AgentListFilter; limit: number },
  ) => Effect.Effect<MessageV2.SubtaskPart[]>
}

export class Service extends Context.Service<Service, Interface>()("@pawwork/SubagentRun") {}

const MAX_ACTIVE = 5

export const layer: Layer.Layer<Service, never, Bus.Service | Session.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service

    const withWriter = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.provideService(eff, SubagentRunWriterContext, true)

    const slotLocks = new Map<SessionID, Semaphore.Semaphore>()
    const activeCounts = new Map<SessionID, number>()
    const rowLocks = new Map<string, Semaphore.Semaphore>()
    const partsByToolCall = new Map<
      string,
      { sessionID: SessionID; messageID: MessageID; partID: PartID }
    >()

    const getSlotLock = (parentID: SessionID) => {
      const hit = slotLocks.get(parentID)
      if (hit) return hit
      const next = Semaphore.makeUnsafe(1)
      slotLocks.set(parentID, next)
      return next
    }

    const getRowLock = (toolCallID: string) => {
      const hit = rowLocks.get(toolCallID)
      if (hit) return hit
      const next = Semaphore.makeUnsafe(1)
      rowLocks.set(toolCallID, next)
      return next
    }

    const reserveSlot = (parentID: SessionID): Effect.Effect<void, TooManyActive> =>
      getSlotLock(parentID).withPermits(1)(
        Effect.gen(function* () {
          const current = activeCounts.get(parentID) ?? 0
          if (current >= MAX_ACTIVE) {
            return yield* Effect.fail(new TooManyActive(parentID))
          }
          activeCounts.set(parentID, current + 1)
        }),
      )

    const releaseSlot = (parentID: SessionID): Effect.Effect<void> =>
      getSlotLock(parentID).withPermits(1)(
        Effect.sync(() => {
          const current = activeCounts.get(parentID) ?? 0
          if (current > 0) activeCounts.set(parentID, current - 1)
        }),
      )

    const readPart = (toolCallID: string) =>
      Effect.gen(function* () {
        const ref = partsByToolCall.get(toolCallID)
        if (!ref) return yield* Effect.fail(new NotFound(toolCallID))
        const got = yield* session.getPart({
          sessionID: ref.sessionID,
          messageID: ref.messageID,
          partID: ref.partID,
        })
        if (!got || got.type !== "subtask") return yield* Effect.fail(new NotFound(toolCallID))
        return got as MessageV2.SubtaskPart
      })

    const start = (input: StartInput): Effect.Effect<MessageV2.SubtaskPart> =>
      withWriter(
        Effect.gen(function* () {
          const partID = PartIDNs.ascending() as PartID
          const now = Date.now()
          const part = {
            type: "subtask" as const,
            id: partID,
            sessionID: input.parent_session_id,
            messageID: input.parent_message_id,
            prompt: input.prompt,
            description: input.description,
            agent: input.agent,
            model: input.model,
            command: input.command,
            tool_call_id: input.tool_call_id,
            parent_session_id: input.parent_session_id,
            parent_message_id: input.parent_message_id,
            subagent_session_id: undefined,
            status: "running" as const,
            started_at: now,
            updated_at: now,
            recent_events: [{ type: "started" as const, at: now }],
          } satisfies MessageV2.SubtaskPart
          partsByToolCall.set(input.tool_call_id, {
            sessionID: input.parent_session_id,
            messageID: input.parent_message_id,
            partID,
          })
          return yield* session.updatePart(part)
        }),
      )

    const patchSession = (toolCallID: string, sessionID: SessionID): Effect.Effect<void> =>
      withWriter(
        getRowLock(toolCallID).withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readPart(toolCallID).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!existing) return
            yield* session.updatePart({
              ...existing,
              subagent_session_id: sessionID,
              updated_at: Date.now(),
            })
          }),
        ),
      )

    const recordActivity = (
      toolCallID: string,
      activity: NonNullable<MessageV2.SubtaskPart["last_activity"]>,
    ): Effect.Effect<void> =>
      withWriter(
        getRowLock(toolCallID).withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readPart(toolCallID).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!existing) return
            yield* session.updatePart({
              ...existing,
              last_activity: activity,
              updated_at: Date.now(),
            })
          }),
        ),
      )

    const LIFECYCLE_KINDS = new Set<MessageV2.SubtaskEvent["type"]>([
      "started",
      "completed",
      "completed_empty",
      "canceled_by_user",
      "failed",
      "consumed",
    ])

    const recordEvent = (toolCallID: string, event: MessageV2.SubtaskEvent): Effect.Effect<void> =>
      withWriter(
        getRowLock(toolCallID).withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readPart(toolCallID).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!existing) return
            const merged = [...existing.recent_events, event]
            while (merged.length > 20) {
              const idx = merged.findIndex((e) => !LIFECYCLE_KINDS.has(e.type))
              if (idx < 0) break
              merged.splice(idx, 1)
            }
            merged.sort((a, b) => a.at - b.at)
            yield* session.updatePart({
              ...existing,
              recent_events: merged,
              updated_at: Date.now(),
            })
          }),
        ),
      )

    const finalize = (
      toolCallID: string,
      status: TerminalStatus,
      fields: FinalizeFields,
    ): Effect.Effect<void> =>
      withWriter(
        getRowLock(toolCallID).withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readPart(toolCallID).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!existing) return
            if (existing.status !== "running") return
            yield* session.updatePart({
              ...existing,
              status,
              ended_at: fields.ended_at ?? Date.now(),
              updated_at: Date.now(),
              ...(fields.result_text !== undefined ? { result_text: fields.result_text } : {}),
              ...(fields.result_summary !== undefined ? { result_summary: fields.result_summary } : {}),
              ...(fields.partial_result !== undefined ? { partial_result: fields.partial_result } : {}),
              ...(fields.error !== undefined ? { error: fields.error } : {}),
            })
          }),
        ),
      )

    const recordRejected = (_input: RejectedInput): Effect.Effect<MessageV2.SubtaskPart> =>
      Effect.die(new Error("SubagentRun.recordRejected: implemented in Task 11"))

    const setConsumed = (toolCallID: string): Effect.Effect<void> =>
      withWriter(
        getRowLock(toolCallID).withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readPart(toolCallID).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!existing) return
            if (existing.consumed_at) return
            yield* session.updatePart({
              ...existing,
              consumed_at: Date.now(),
              updated_at: Date.now(),
            })
          }),
        ),
      )

    const read = (toolCallID: string): Effect.Effect<MessageV2.SubtaskPart, NotFound> =>
      readPart(toolCallID)

    const findLatestBySessionID = (
      _parentID: SessionID,
      _subagentSessionID: SessionID,
    ): Effect.Effect<MessageV2.SubtaskPart, NotFound> =>
      Effect.die(new Error("SubagentRun.findLatestBySessionID: implemented in Task 13"))

    const list = (
      _parentID: SessionID,
      _filter: { status: AgentListFilter; limit: number },
    ): Effect.Effect<MessageV2.SubtaskPart[]> =>
      Effect.die(new Error("SubagentRun.list: implemented in Task 12"))

    return Service.of({
      reserveSlot,
      releaseSlot,
      start,
      patchSession,
      recordEvent,
      recordActivity,
      finalize,
      recordRejected,
      setConsumed,
      read,
      findLatestBySessionID,
      list,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Session.defaultLayer),
)

export * as SubagentRun from "./subagent-run"
