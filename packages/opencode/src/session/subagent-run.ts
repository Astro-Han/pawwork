import { Context, Effect, Layer, Semaphore } from "effect"
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
  command?: string
  model?: { providerID: ProviderID; modelID: ModelID }
  reason: string
}

export interface Interface {
  readonly reserveSlot: (parentID: SessionID) => Effect.Effect<void, TooManyActive>
  readonly releaseSlot: (parentID: SessionID) => Effect.Effect<void>
  readonly activeForSession: (parentID: SessionID) => Effect.Effect<boolean>
  readonly start: (input: StartInput) => Effect.Effect<MessageV2.SubtaskPart>
  readonly patchSession: (toolCallID: string, sessionID: SessionID) => Effect.Effect<void>
  readonly recordEvent: (toolCallID: string, event: MessageV2.SubtaskEvent) => Effect.Effect<void>
  readonly finalize: (
    toolCallID: string,
    status: TerminalStatus,
    fields: FinalizeFields,
  ) => Effect.Effect<void>
  readonly recordRejected: (input: RejectedInput) => Effect.Effect<MessageV2.SubtaskPart>
  readonly setConsumed: (toolCallID: string) => Effect.Effect<void>
  readonly read: (toolCallID: string) => Effect.Effect<MessageV2.SubtaskPart, NotFound>
  /**
   * Same as `read` but falls back to scanning the parent session's persisted parts when the
   * in-memory tool_call_id index misses (e.g., after a host restart). agent_output uses this
   * path so `agent_output { tool_call_id }` keeps working across restarts.
   */
  readonly readByToolCallID: (
    parentID: SessionID,
    toolCallID: string,
  ) => Effect.Effect<MessageV2.SubtaskPart, NotFound>
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

// Default cap on parallel subagent dispatches per parent. Picked to stay within typical
// per-conversation token / context budgets while still letting parents fan out useful
// work. Not currently configurable; promoting to Config is a v1.1 follow-up.
const MAX_ACTIVE = 5

export const layer: Layer.Layer<Service, never, Session.Service> = Layer.effect(
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
        Effect.gen(function* () {
          const current = activeCounts.get(parentID) ?? 0
          // Underflow is always a bug (release without matching reserve). Die so the invariant
          // violation surfaces instead of silently clipping at 0 and hiding double-release.
          if (current <= 0) return yield* Effect.die(new Error(`releaseSlot underflow for ${parentID}`))
          activeCounts.set(parentID, current - 1)
        }),
      )

    const activeForSession = (parentID: SessionID): Effect.Effect<boolean> =>
      getSlotLock(parentID).withPermits(1)(Effect.succeed((activeCounts.get(parentID) ?? 0) > 0))

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
        return hydrateSubtask(got as MessageV2.SubtaskPart)
      })

    // DRY shell for "read row, no-op if missing, then write under row mutex with writer context".
    // All single-row mutators reuse this so the catch surface is uniform: NotFound (row missing
    // from both cache and persistence) becomes a silent no-op; non-NotFound failures (storage
    // errors, etc.) propagate as defects rather than getting swallowed as a missing row.
    const withExistingPart = (
      toolCallID: string,
      mutate: (existing: MessageV2.SubtaskPart) => Effect.Effect<void>,
    ): Effect.Effect<void> =>
      withWriter(
        getRowLock(toolCallID).withPermits(1)(
          Effect.gen(function* () {
            const existing = yield* readPart(toolCallID).pipe(
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            )
            if (!existing) return
            yield* mutate(existing)
          }),
        ),
      )

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
          const persisted = yield* session.updatePart(part)
          // Index after persistence — if updatePart fails, the cache stays clean instead of
          // pointing at a row that does not exist in storage.
          partsByToolCall.set(input.tool_call_id, {
            sessionID: input.parent_session_id,
            messageID: input.parent_message_id,
            partID,
          })
          return persisted
        }),
      )

    const patchSession = (toolCallID: string, sessionID: SessionID): Effect.Effect<void> =>
      withExistingPart(toolCallID, (existing) =>
        Effect.gen(function* () {
          // Single-assignment: same id is a no-op, different id is a defect. Re-pointing
          // a row to a new child would corrupt findLatestBySessionID and ownership checks.
          if (existing.subagent_session_id === sessionID) return
          if (existing.subagent_session_id && existing.subagent_session_id !== sessionID) {
            return yield* Effect.die(
              new Error(
                `subagent_session_id already set for ${toolCallID} (have ${existing.subagent_session_id}, got ${sessionID})`,
              ),
            )
          }
          yield* session.updatePart({
            ...existing,
            subagent_session_id: sessionID,
            updated_at: Date.now(),
          })
        }),
      )

    const LIFECYCLE_KINDS = new Set<MessageV2.SubtaskEvent["type"]>([
      "started",
      "completed",
      "completed_empty",
      "canceled_by_user",
      "failed",
      "consumed",
    ])

    // Append `event` to `existing` and apply ring eviction + stable sort. Shared by recordEvent,
    // finalize, and setConsumed so every state transition lands in recent_events with consistent
    // capping behavior. Lifecycle events (started / <terminal> / consumed) are never evicted in
    // favor of progress events; if the ring is all lifecycle and overflows, the oldest lifecycle
    // entry yields. Sort breaks ties on insertion index for deterministic ordering.
    const appendLifecycleEvent = (
      existing: ReadonlyArray<MessageV2.SubtaskEvent>,
      event: MessageV2.SubtaskEvent,
    ): MessageV2.SubtaskEvent[] => {
      const merged = [...existing, event]
      while (merged.length > 20) {
        const idx = merged.findIndex((e) => !LIFECYCLE_KINDS.has(e.type))
        if (idx < 0) break
        merged.splice(idx, 1)
      }
      while (merged.length > 20) merged.shift()
      const indexed = merged.map((e, i) => ({ e, i }))
      indexed.sort((a, b) => a.e.at - b.e.at || a.i - b.i)
      return indexed.map((x) => x.e)
    }

    const recordEvent = (toolCallID: string, event: MessageV2.SubtaskEvent): Effect.Effect<void> =>
      withExistingPart(toolCallID, (existing) =>
        session.updatePart({
          ...existing,
          recent_events: appendLifecycleEvent(existing.recent_events, event),
          updated_at: Date.now(),
        }).pipe(Effect.asVoid),
      )

    const finalize = (
      toolCallID: string,
      status: TerminalStatus,
      fields: FinalizeFields,
    ): Effect.Effect<void> =>
      withExistingPart(toolCallID, (existing) =>
        Effect.gen(function* () {
          if (existing.status !== "running") return
          const now = Date.now()
          // Append the matching terminal event so recent_events records the actual transition
          // (started → <terminal>) instead of leaving the ring stuck at "started".
          const event: MessageV2.SubtaskEvent =
            status === "failed"
              ? { type: "failed", kind: fields.error?.kind ?? "unknown", at: now }
              : { type: status, at: now }
          const merged = appendLifecycleEvent(existing.recent_events, event)
          yield* session.updatePart({
            ...existing,
            status,
            ended_at: fields.ended_at ?? now,
            updated_at: now,
            recent_events: merged,
            ...(fields.result_text !== undefined ? { result_text: fields.result_text } : {}),
            ...(fields.result_summary !== undefined ? { result_summary: fields.result_summary } : {}),
            ...(fields.partial_result !== undefined ? { partial_result: fields.partial_result } : {}),
            ...(fields.error !== undefined ? { error: fields.error } : {}),
          })
        }),
      )

    const recordRejected = (input: RejectedInput): Effect.Effect<MessageV2.SubtaskPart> =>
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
            status: "failed" as const,
            started_at: now,
            updated_at: now,
            ended_at: now,
            recent_events: [
              { type: "started" as const, at: now },
              { type: "failed" as const, kind: "too_many_active", at: now },
            ],
            error: { kind: "too_many_active", message: input.reason },
          } satisfies MessageV2.SubtaskPart
          const persisted = yield* session.updatePart(part)
          // Index after persistence — same rationale as `start`.
          partsByToolCall.set(input.tool_call_id, {
            sessionID: input.parent_session_id,
            messageID: input.parent_message_id,
            partID,
          })
          return persisted
        }),
      )

    const setConsumed = (toolCallID: string): Effect.Effect<void> =>
      withExistingPart(toolCallID, (existing) =>
        Effect.gen(function* () {
          if (existing.consumed_at) return
          const now = Date.now()
          const merged = appendLifecycleEvent(existing.recent_events, { type: "consumed", at: now })
          yield* session.updatePart({
            ...existing,
            consumed_at: now,
            updated_at: now,
            recent_events: merged,
          })
        }),
      )

    const read = (toolCallID: string): Effect.Effect<MessageV2.SubtaskPart, NotFound> =>
      readPart(toolCallID)

    const readByToolCallID = (
      parentID: SessionID,
      toolCallID: string,
    ): Effect.Effect<MessageV2.SubtaskPart, NotFound> =>
      readPart(toolCallID).pipe(
        Effect.catchTag("NotFound", () =>
          Effect.gen(function* () {
            const all = yield* collectSubtaskParts(parentID)
            const match = all.find((p) => p.tool_call_id === toolCallID)
            if (!match) return yield* Effect.fail(new NotFound(toolCallID))
            // Refresh the in-memory index so subsequent reads/writes from the same process hit
            // the fast path. Best-effort: a row reachable via persistence has stable identity.
            partsByToolCall.set(toolCallID, {
              sessionID: match.sessionID,
              messageID: match.messageID,
              partID: match.id,
            })
            return match
          }),
        ),
      )

    // Coerces lifecycle defaults that the SubtaskPart zod schema would have applied during a
    // parse pass. Necessary because MessageV2.parts() returns `row.data as Part` without parsing,
    // so legacy rows persisted before this PR can reach list/output as `status === undefined`.
    // Without this, agent_list renders "undefined (unread)" for old subtask rows.
    const hydrateSubtask = (p: MessageV2.SubtaskPart): MessageV2.SubtaskPart => ({
      ...p,
      status: p.status ?? "completed",
      recent_events: p.recent_events ?? [],
    })

    const collectSubtaskParts = (parentID: SessionID): Effect.Effect<MessageV2.SubtaskPart[]> =>
      Effect.gen(function* () {
        const messages = yield* session.messages({ sessionID: parentID })
        const parts: MessageV2.SubtaskPart[] = []
        for (const m of messages) {
          for (const p of m.parts) {
            if (p.type === "subtask") parts.push(hydrateSubtask(p))
          }
        }
        return parts
      })

    const matchesFilter = (
      part: MessageV2.SubtaskPart,
      filter: AgentListFilter,
    ): boolean => {
      if (filter === "all") return true
      if (filter === "all_active") return part.status === "running" || !part.consumed_at
      return part.status === filter
    }

    const findLatestBySessionID = (
      parentID: SessionID,
      subagentSessionID: SessionID,
    ): Effect.Effect<MessageV2.SubtaskPart, NotFound> =>
      Effect.gen(function* () {
        const all = yield* collectSubtaskParts(parentID)
        // Tie-break started_at on insertion index (newer scan order) so two rows started in the
        // same millisecond — possible under burst dispatch — pick the most recently inserted
        // row deterministically instead of the first one we happened to see.
        const matches = all
          .map((p, index) => ({ p, index }))
          .filter(({ p }) => p.subagent_session_id === subagentSessionID)
        if (matches.length === 0) return yield* Effect.fail(new NotFound(subagentSessionID))
        matches.sort(
          (a, b) =>
            (b.p.started_at ?? 0) - (a.p.started_at ?? 0) || b.index - a.index,
        )
        const match = matches[0].p
        // Refresh the in-memory index so subsequent `setConsumed` / `recordEvent` on this row
        // hit the fast path. Without this, `agent_output` finding a row by subagent_session_id
        // after a host restart would fail to mark it consumed (withExistingPart's NotFound
        // no-op path swallows the mutation).
        if (match.tool_call_id) {
          partsByToolCall.set(match.tool_call_id, {
            sessionID: match.sessionID,
            messageID: match.messageID,
            partID: match.id,
          })
        }
        return match
      })

    const list = (
      parentID: SessionID,
      filter: { status: AgentListFilter; limit: number },
    ): Effect.Effect<MessageV2.SubtaskPart[]> =>
      Effect.gen(function* () {
        const all = yield* collectSubtaskParts(parentID)
        // Same tie-break rationale as findLatestBySessionID — burst dispatch can collide on
        // started_at, so secondary-sort on insertion index for deterministic newest-first order.
        const filtered = all
          .map((p, index) => ({ p, index }))
          .filter(({ p }) => matchesFilter(p, filter.status))
        filtered.sort(
          (a, b) =>
            (b.p.started_at ?? 0) - (a.p.started_at ?? 0) || b.index - a.index,
        )
        return filtered.slice(0, filter.limit).map(({ p }) => p)
      })

    return Service.of({
      reserveSlot,
      releaseSlot,
      activeForSession,
      start,
      patchSession,
      recordEvent,
      finalize,
      recordRejected,
      setConsumed,
      read,
      readByToolCallID,
      findLatestBySessionID,
      list,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(Session.defaultLayer),
)

export * as SubagentRun from "./subagent-run"
