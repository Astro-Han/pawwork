import { MessageID } from "../schema"
import {
  AttemptID,
  type AttemptSummary,
  type Classification,
  type Recorder,
  type RecorderInput,
  RunID,
  SCHEMA_VERSION,
  type Summary,
  type SummaryKey,
  type ToolEffectKind,
} from "./types"
import { safeErrorFingerprint } from "./sanitize"

type AttemptMutable = AttemptSummary & { lastMonotonicMs: number }

type Failure =
  | { type: "transport"; at: number; monotonicMs: number; error: unknown; evidence: string[]; attemptID?: AttemptID }
  | { type: "setup"; at: number; monotonicMs: number; error: unknown }
  | {
      type: "scope_closed"
      at: number
      monotonicMs: number
      source?: string
      reason?: string
      lifecycleActionID?: string
    }
  | { type: "tool"; at: number; monotonicMs: number; error?: unknown; attemptID?: AttemptID }

export function createRecorder(input: RecorderInput): Recorder {
  const attempts: AttemptMutable[] = []
  const unsafeKinds: ToolEffectKind[] = []
  let providerProgressSeen = false
  let visibleOutputSeen = false
  let toolCallSeen = false
  let toolExecutionStarted = false
  let readOnlyToolStarted = false
  let unsafeSideEffectStarted = false
  let sideEffectFactsComplete = true
  let lastEventMonotonicMs = input.monotonicStartMs
  let failure: Failure | undefined

  const rememberEvent = (monotonicMs: number) => {
    lastEventMonotonicMs = Math.max(lastEventMonotonicMs, monotonicMs)
  }
  const getAttempt = (attemptID: AttemptID | undefined) => attempts.find((attempt) => attempt.attempt_id === attemptID)
  const updateAttempt = (attemptID: AttemptID | undefined, fn: (attempt: AttemptMutable) => void) => {
    const attempt = getAttempt(attemptID)
    if (attempt) fn(attempt)
  }

  return {
    beginAttempt(next) {
      const attemptID = AttemptID.parse(`${input.runID}:attempt:${next.attemptIndex}`)
      attempts.push({
        attempt_id: attemptID,
        attempt_index: next.attemptIndex,
        started_at: next.at,
        provider_progress_seen: false,
        visible_output_seen: false,
        tool_call_seen: false,
        tool_execution_started: false,
        unsafe_side_effect_started: false,
        lastMonotonicMs: next.monotonicMs,
      })
      rememberEvent(next.monotonicMs)
      return { attemptID }
    },
    recordProviderProgress(next) {
      providerProgressSeen = true
      updateAttempt(next.attemptID, (attempt) => {
        attempt.provider_progress_seen = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      rememberEvent(next.monotonicMs)
    },
    recordVisibleOutput(next) {
      visibleOutputSeen = true
      updateAttempt(next.attemptID, (attempt) => {
        attempt.visible_output_seen = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolCall(next) {
      toolCallSeen = true
      updateAttempt(next.attemptID, (attempt) => {
        attempt.tool_call_seen = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolExecutionStarted(next) {
      void next.toolName
      toolExecutionStarted = true
      if (next.effect.kind === "read_only") readOnlyToolStarted = true
      if (!next.effect.complete) sideEffectFactsComplete = false
      if (next.effect.unsafe) {
        unsafeSideEffectStarted = true
        if (!unsafeKinds.includes(next.effect.kind)) unsafeKinds.push(next.effect.kind)
      }
      updateAttempt(next.attemptID, (attempt) => {
        attempt.tool_execution_started = true
        attempt.unsafe_side_effect_started ||= next.effect.unsafe
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolCompleted(next) {
      updateAttempt(next.attemptID, (attempt) => {
        attempt.last_tool_completed_at = next.at
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolFailed(next) {
      if (failure?.type === "setup" || failure?.type === "scope_closed") return
      failure = {
        type: "tool",
        at: next.at,
        monotonicMs: next.monotonicMs,
        error: next.error,
        attemptID: next.attemptID,
      }
      rememberEvent(next.monotonicMs)
    },
    recordToolInterrupted(next) {
      if (failure?.type === "setup" || failure?.type === "scope_closed") return
      failure = { type: "tool", at: next.at, monotonicMs: next.monotonicMs, attemptID: next.attemptID }
      rememberEvent(next.monotonicMs)
    },
    recordTransportFailure(next) {
      if (failure?.type === "scope_closed" || failure?.type === "setup" || failure?.type === "tool") return
      failure = {
        type: "transport",
        at: next.at,
        monotonicMs: next.monotonicMs,
        error: next.error,
        evidence: next.evidence ?? [],
        attemptID: next.attemptID,
      }
      rememberEvent(next.monotonicMs)
    },
    recordSetupFailure(next) {
      if (failure?.type === "scope_closed") return
      failure = { type: "setup", at: next.at, monotonicMs: next.monotonicMs, error: next.error }
      rememberEvent(next.monotonicMs)
    },
    recordScopeClosed(next) {
      failure = {
        type: "scope_closed",
        at: next.at,
        monotonicMs: next.monotonicMs,
        source: next.source,
        reason: next.reason,
        lifecycleActionID: next.lifecycleActionID,
      }
      rememberEvent(next.monotonicMs)
    },
    finalize(final) {
      const classification = classify(failure)
      const missingProvenance = classification === "unknown_scope_close" ? ["lifecycle.close_requested"] : undefined
      const summaryKey = summaryKeyFor(classification, summarySuffix({ failure, providerProgressSeen }))
      const retrySafety = retrySafetyFor({
        classification,
        visibleOutputSeen,
        toolExecutionStarted,
        unsafeSideEffectStarted,
      })
      const completedAt = final.completedAt
      const failureMonotonicMs = failure?.monotonicMs
      const error = failure && "error" in failure ? safeErrorFingerprint(failure.error) : undefined
      const terminalAttemptID = failure && "attemptID" in failure ? failure.attemptID : attempts.at(-1)?.attempt_id
      return {
        schema_version: SCHEMA_VERSION,
        run_id: input.runID,
        trace_id: input.traceID,
        session_id: input.sessionID,
        message_id: input.messageID,
        parent_message_id: input.parentMessageID,
        provider: input.providerID,
        model: input.modelID,
        created_at: input.createdAt,
        completed_at: completedAt,
        classification,
        summary_key: summaryKey,
        retry_safety: retrySafety,
        attempts: attempts.map(({ lastMonotonicMs, ...attempt }) => attempt),
        terminal_attempt_id: terminalAttemptID,
        provider_progress_seen: providerProgressSeen,
        visible_output_seen: visibleOutputSeen,
        tool_call_seen: toolCallSeen,
        tool_execution_started: toolExecutionStarted,
        read_only_tool_started: readOnlyToolStarted,
        unsafe_side_effect_started: unsafeSideEffectStarted,
        unsafe_side_effect_kinds: unsafeKinds,
        side_effect_facts_complete: sideEffectFactsComplete,
        missing_provenance: missingProvenance,
        durations_ms: {
          total: duration(input.monotonicStartMs, final.monotonicMs),
          last_event_to_failure:
            failureMonotonicMs === undefined
              ? undefined
              : duration(lastEventBeforeFailure(failureMonotonicMs), failureMonotonicMs),
        },
        error,
      } satisfies Summary
    },
  }

  function lastEventBeforeFailure(failureMonotonicMs: number) {
    const candidates = attempts.map((attempt) => attempt.lastMonotonicMs).filter((value) => value <= failureMonotonicMs)
    return candidates.length ? Math.max(...candidates) : lastEventMonotonicMs
  }
}

function classify(failure: Failure | undefined): Classification {
  if (!failure) return "success"
  if (failure.type === "setup") return "request_setup_failure"
  if (failure.type === "tool") return "tool_failure"
  if (failure.type === "scope_closed")
    return failure.lifecycleActionID ? "known_lifecycle_close" : "unknown_scope_close"
  if (failure.type === "transport") return "external_stream_disconnect"
  return "unknown_failure"
}

function summarySuffix(input: { failure: Failure | undefined; providerProgressSeen: boolean }) {
  if (input.failure?.type === "transport") {
    const error = safeErrorFingerprint(input.failure.error)
    if (input.providerProgressSeen && error.cause_code === "UND_ERR_SOCKET") return "provider_progress_socket_closed"
    if (input.providerProgressSeen) return "provider_progress_transport_failure"
    return "transport_failure"
  }
  if (input.failure?.type === "scope_closed") return "missing_lifecycle_provenance"
  if (input.failure?.type === "setup") return "request_setup_failed"
  if (input.failure?.type === "tool") return "tool_execution_failed"
  if (!input.failure) return "completed"
  return "unknown"
}

export function summaryKeyFor(classification: Classification, suffix: string): SummaryKey {
  return `${classification}.${suffix}` as SummaryKey
}

export function isProviderProgressEvent(event: { type: string }) {
  switch (event.type) {
    case "text-start":
    case "text-delta":
    case "reasoning-start":
    case "reasoning-delta":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-call":
    case "tool-result":
    case "tool-error":
      return true
    default:
      return false
  }
}

function retrySafetyFor(input: {
  classification: Classification
  visibleOutputSeen: boolean
  toolExecutionStarted: boolean
  unsafeSideEffectStarted: boolean
}): Summary["retry_safety"] {
  const base = { safety_scope: "user_visible_and_tool_side_effects" as const }
  if (input.classification === "success") {
    return { ...base, recommendation: "unknown", confidence: "high", reason: "completed_without_failure" }
  }
  if (input.visibleOutputSeen) {
    return { ...base, recommendation: "do_not_auto_retry", confidence: "high", reason: "visible_output_seen" }
  }
  if (input.unsafeSideEffectStarted) {
    return { ...base, recommendation: "do_not_auto_retry", confidence: "high", reason: "unsafe_side_effect_started" }
  }
  if (input.toolExecutionStarted) {
    return { ...base, recommendation: "ask_user", confidence: "medium", reason: "tool_execution_started" }
  }
  if (input.classification === "external_stream_disconnect") {
    return {
      ...base,
      recommendation: "candidate_safe_auto_retry",
      confidence: "medium",
      reason: "no_visible_output_or_tool_execution",
    }
  }
  if (input.classification === "known_lifecycle_close" || input.classification === "unknown_scope_close") {
    return {
      ...base,
      recommendation: "do_not_auto_retry",
      confidence: "medium",
      reason: "local_abort_or_lifecycle_close",
    }
  }
  return { ...base, recommendation: "unknown", confidence: "low", reason: "unknown" }
}

function duration(start: number | undefined, end: number) {
  if (start === undefined) return undefined
  return Math.max(0, end - start)
}

export const makeRunID = (messageID: MessageID): RunID => RunID.parse(`run:${messageID}`)
