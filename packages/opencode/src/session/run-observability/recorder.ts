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
  type LifecycleKind,
  type ToolEffectKind,
} from "./types"
import { safeErrorFingerprint } from "./sanitize"
import { RunIncident } from "../run-incident"
import { cloneRequest, type LifecycleRequest } from "../lifecycle-provenance"

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
      lifecycleKind?: LifecycleKind
      lifecycleInitiatedAt?: number
      lifecycleInitiatedMonotonicMs?: number
      lifecycleAffectedDirectoryKeys?: string[]
      lifecycleOrigin?: { source: string; operation?: string; reason?: string }
      lifecycleRequest?: LifecycleRequest
    }
  | { type: "tool"; at: number; monotonicMs: number; error?: unknown; attemptID?: AttemptID }

type ScopeClosedFailure = Extract<Failure, { type: "scope_closed" }>

export function createRecorder(input: RecorderInput): Recorder {
  const attempts: AttemptMutable[] = []
  const unsafeKinds: ToolEffectKind[] = []
  let providerProgressSeen = false
  let visibleOutputSeen = false
  let toolCallSeen = false
  let toolInputStarted = false
  let toolInputCompleted = false
  let toolCallMaterialized = false
  let toolExecutionStarted = false
  let toolExecutionCompleted = false
  let readOnlyToolStarted = false
  let unsafeSideEffectStarted = false
  let sideEffectFactsComplete = true
  const materializedToolBoundaries: RunIncident.MaterializedToolBoundary[] = []
  let lastEventMonotonicMs = input.monotonicStartMs
  let failure: Failure | undefined
  let lifecycleFailure: ScopeClosedFailure | undefined
  let pendingToolPartsInterrupted = 0
  const evidence: RunIncident.EvidenceEvent[] = []

  const rememberEvent = (monotonicMs: number) => {
    lastEventMonotonicMs = Math.max(lastEventMonotonicMs, monotonicMs)
  }
  const getAttempt = (attemptID: AttemptID | undefined) => attempts.find((attempt) => attempt.attempt_id === attemptID)
  const updateAttempt = (attemptID: AttemptID | undefined, fn: (attempt: AttemptMutable) => void) => {
    const attempt = getAttempt(attemptID)
    if (attempt) fn(attempt)
  }
  const appendEvidence = (next: Omit<RunIncident.EvidenceEvent, "event_id" | "order">) => {
    const order = evidence.length + 1
    evidence.push({
      ...next,
      order,
      event_id: `incident:${input.messageID}:evidence:${order}`,
    })
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
        tool_input_started: false,
        tool_input_completed: false,
        tool_call_materialized: false,
        tool_execution_started: false,
        unsafe_side_effect_started: false,
        lastMonotonicMs: next.monotonicMs,
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "processor",
        attempt_id: attemptID,
        event_type: "attempt_started",
        terminal_candidate: false,
        confidence: "high",
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
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: "provider_progress_seen",
        terminal_candidate: false,
        confidence: "high",
      })
      rememberEvent(next.monotonicMs)
    },
    recordVisibleOutput(next) {
      visibleOutputSeen = true
      updateAttempt(next.attemptID, (attempt) => {
        attempt.visible_output_seen = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: next.kind === "reasoning" ? "reasoning_output_started" : "text_output_started",
        terminal_candidate: false,
        confidence: "high",
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: "visible_output_seen",
        terminal_candidate: false,
        confidence: "high",
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolInputStarted(next) {
      toolInputStarted = true
      if (next.providerExecuted) sideEffectFactsComplete = false
      updateAttempt(next.attemptID, (attempt) => {
        attempt.tool_input_started = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: "tool_input_started",
        terminal_candidate: false,
        confidence: "high",
      })
      if (next.providerExecuted) {
        appendEvidence({
          monotonic_ms: next.monotonicMs,
          source: "provider_stream",
          attempt_id: next.attemptID,
          event_type: "provider_executed_tool_boundary",
          terminal_candidate: false,
          confidence: "medium",
        })
      }
      rememberEvent(next.monotonicMs)
    },
    recordToolInputCompleted(next) {
      toolInputCompleted = true
      updateAttempt(next.attemptID, (attempt) => {
        attempt.tool_input_completed = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: "tool_input_completed",
        terminal_candidate: false,
        confidence: "high",
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolCallMaterialized(next) {
      toolCallSeen = true
      toolCallMaterialized = true
      const effect = next.effect ?? { kind: "unknown", unsafe: true, complete: false as const }
      materializedToolBoundaries.push({ attempt_id: next.attemptID, tool: next.toolName, effect })
      if (next.providerExecuted || !effect.complete) sideEffectFactsComplete = false
      updateAttempt(next.attemptID, (attempt) => {
        attempt.tool_call_seen = true
        attempt.tool_call_materialized = true
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: "tool_call_materialized",
        terminal_candidate: false,
        confidence: "high",
        tool_name: next.toolName,
        tool_effect_kind: effect.kind,
        tool_effect_unsafe: effect.unsafe,
        tool_effect_complete: effect.complete,
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
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "tool_runner",
        attempt_id: next.attemptID,
        event_type: "tool_execution_started",
        terminal_candidate: false,
        confidence: "high",
        tool_name: next.toolName,
      })
      if (next.effect.kind === "read_only") {
        appendEvidence({
          monotonic_ms: next.monotonicMs,
          source: "tool_runner",
          attempt_id: next.attemptID,
          event_type: "read_only_tool_started",
          terminal_candidate: false,
          confidence: "high",
          tool_name: next.toolName,
        })
      }
      if (next.effect.unsafe) {
        appendEvidence({
          monotonic_ms: next.monotonicMs,
          source: "tool_runner",
          attempt_id: next.attemptID,
          event_type: "unsafe_side_effect_started",
          terminal_candidate: false,
          confidence: next.effect.complete ? "high" : "medium",
          tool_name: next.toolName,
        })
      }
      rememberEvent(next.monotonicMs)
    },
    recordToolCompleted(next) {
      toolExecutionCompleted = true
      updateAttempt(next.attemptID, (attempt) => {
        attempt.last_tool_completed_at = next.at
        attempt.lastMonotonicMs = Math.max(attempt.lastMonotonicMs, next.monotonicMs)
      })
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "tool_runner",
        attempt_id: next.attemptID,
        event_type: "tool_execution_completed",
        terminal_candidate: false,
        confidence: "high",
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolFailed(next) {
      failure ??= {
        type: "tool",
        at: next.at,
        monotonicMs: next.monotonicMs,
        error: next.error,
        attemptID: next.attemptID,
      }
      const error = safeErrorFingerprint(next.error)
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "tool_runner",
        attempt_id: next.attemptID,
        event_type: "tool_execution_failure",
        terminal_candidate: true,
        confidence: "high",
        error,
        cause: { category: "tool_execution_failure", error, confidence: "high" },
      })
      rememberEvent(next.monotonicMs)
    },
    recordToolInterrupted(next) {
      const attempt = getAttempt(next.attemptID)
      if (!attempt?.tool_execution_started) {
        pendingToolPartsInterrupted++
        appendEvidence({
          monotonic_ms: next.monotonicMs,
          source: "processor",
          attempt_id: next.attemptID,
          event_type: "pending_tool_part_interrupted",
          terminal_candidate: false,
          confidence: "medium",
          redactions: ["raw_tool_input"],
          interruption_phase: attempt?.tool_call_materialized
            ? "tool_call_materialized_without_execution"
            : "tool_input_generation",
          tool_execution_started: false,
        })
        rememberEvent(next.monotonicMs)
        return
      }
      failure ??= { type: "tool", at: next.at, monotonicMs: next.monotonicMs, attemptID: next.attemptID }
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "tool_runner",
        attempt_id: next.attemptID,
        event_type: "tool_execution_interrupted",
        terminal_candidate: true,
        confidence: "medium",
        interruption_phase: "tool_execution",
        tool_execution_started: true,
        cause: { category: "tool_execution_interrupted", confidence: "medium" },
      })
      rememberEvent(next.monotonicMs)
    },
    recordPendingToolPartInterrupted(next) {
      pendingToolPartsInterrupted++
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "processor",
        attempt_id: next.attemptID,
        event_type: "pending_tool_part_interrupted",
        terminal_candidate: false,
        confidence: "medium",
        redactions: ["raw_tool_input"],
        interruption_phase: next.interruptionPhase,
        tool_execution_started: next.toolExecutionStarted,
      })
      rememberEvent(next.monotonicMs)
    },
    recordTransportFailure(next) {
      const error = safeErrorFingerprint(next.error)
      failure ??= {
        type: "transport",
        at: next.at,
        monotonicMs: next.monotonicMs,
        error: next.error,
        evidence: next.evidence ?? [],
        attemptID: next.attemptID,
      }
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "provider_stream",
        attempt_id: next.attemptID,
        event_type: "provider_transport_failure",
        terminal_candidate: true,
        confidence: error.cause_code === "UND_ERR_SOCKET" ? "high" : "medium",
        error,
        cause: RunIncident.transportCause({
          error,
          providerProgressSeen: getAttempt(next.attemptID)?.provider_progress_seen ?? providerProgressSeen,
          toolInputStarted: getAttempt(next.attemptID)?.tool_input_started ?? toolInputStarted,
          toolInputCompleted: getAttempt(next.attemptID)?.tool_input_completed ?? toolInputCompleted,
          toolCallMaterialized: getAttempt(next.attemptID)?.tool_call_materialized ?? toolCallMaterialized,
          toolExecutionStarted: getAttempt(next.attemptID)?.tool_execution_started ?? toolExecutionStarted,
        }),
      })
      rememberEvent(next.monotonicMs)
    },
    recordSetupFailure(next) {
      failure ??= { type: "setup", at: next.at, monotonicMs: next.monotonicMs, error: next.error }
      const error = safeErrorFingerprint(next.error)
      appendEvidence({
        monotonic_ms: next.monotonicMs,
        source: "processor",
        event_type: "request_setup_failure",
        terminal_candidate: true,
        confidence: "high",
        error,
        cause: { category: "request_setup_failure", error, confidence: "high" },
      })
      rememberEvent(next.monotonicMs)
    },
    recordScopeClosed(next) {
      const lifecycleCauseMonotonicMs = next.lifecycleInitiatedMonotonicMs ?? next.monotonicMs
      const nextFailure: ScopeClosedFailure = {
        type: "scope_closed",
        at: next.at,
        monotonicMs: next.monotonicMs,
        source: next.source,
        reason: next.reason,
        lifecycleActionID: next.lifecycleActionID,
        lifecycleKind: next.lifecycleKind,
        lifecycleInitiatedAt: next.lifecycleInitiatedAt,
        lifecycleInitiatedMonotonicMs: next.lifecycleInitiatedMonotonicMs,
        lifecycleAffectedDirectoryKeys: next.lifecycleAffectedDirectoryKeys
          ? [...next.lifecycleAffectedDirectoryKeys]
          : undefined,
        lifecycleOrigin: next.lifecycleOrigin ? { ...next.lifecycleOrigin } : undefined,
        lifecycleRequest: next.lifecycleRequest ? cloneRequest(next.lifecycleRequest) : undefined,
      }
      failure ??= nextFailure
      lifecycleFailure = earlierLifecycleFailure(lifecycleFailure, nextFailure)
      appendEvidence({
        monotonic_ms: lifecycleCauseMonotonicMs,
        source: "lifecycle",
        event_type: "lifecycle_close_seen",
        terminal_candidate: true,
        confidence: next.lifecycleActionID ? "high" : "medium",
        cause: {
          category: "local_lifecycle_close",
          subcategory: next.lifecycleKind ?? "unknown_lifecycle_close",
          confidence: next.lifecycleActionID ? "high" : "medium",
        },
      })
      if (lifecycleCauseMonotonicMs !== next.monotonicMs) {
        appendEvidence({
          monotonic_ms: next.monotonicMs,
          source: "lifecycle",
          event_type: "lifecycle_close_propagated",
          terminal_candidate: false,
          confidence: next.lifecycleActionID ? "high" : "medium",
        })
      }
      rememberEvent(next.monotonicMs)
    },
    finalize(final) {
      const lifecycle = lifecycleSummary(lifecycleFailure)
      const incidentLifecycle = lifecycleSummary(lifecycleFailure)
      const incident = RunIncident.derive({
        runID: input.runID,
        traceID: input.traceID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        parentMessageID: input.parentMessageID,
        createdAt: input.createdAt,
        completedAt: final.completedAt,
        evidence,
        unsafeSideEffectKinds: unsafeKinds,
        sideEffectFactsComplete,
        materializedToolBoundaries,
        lifecycle: incidentLifecycle,
        missingProvenance: lifecycleFailure && !lifecycle ? ["lifecycle.close_requested"] : undefined,
      })
      const classification = incident ? classificationForIncident(incident.terminal_cause) : classify(failure)
      const missingProvenance = classification === "unknown_scope_close" ? ["lifecycle.close_requested"] : undefined
      const summaryKey = summaryKeyFor(
        classification,
        incident
          ? summarySuffixForIncident(incident.terminal_cause, { providerProgressSeen })
          : summarySuffix({ failure, providerProgressSeen }),
      )
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
        tool_input_started: toolInputStarted,
        tool_input_completed: toolInputCompleted,
        tool_call_materialized: toolCallMaterialized,
        tool_execution_started: toolExecutionStarted,
        read_only_tool_started: readOnlyToolStarted,
        unsafe_side_effect_started: unsafeSideEffectStarted,
        unsafe_side_effect_kinds: unsafeKinds,
        side_effect_facts_complete: sideEffectFactsComplete,
        pending_tool_parts_interrupted: pendingToolPartsInterrupted || undefined,
        incident,
        lifecycle,
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
  if (failure.type === "scope_closed") {
    if (failure.lifecycleKind === "instance_reload") return "local_instance_reload"
    if (
      failure.lifecycleKind === "instance_dispose" ||
      failure.lifecycleKind === "instance_dispose_directory" ||
      failure.lifecycleKind === "instance_dispose_all"
    )
      return "local_instance_dispose"
    return failure.lifecycleActionID ? "known_lifecycle_close" : "unknown_scope_close"
  }
  if (failure.type === "transport") return "external_stream_disconnect"
  return "unknown_failure"
}

function classificationForIncident(cause: RunIncident.TerminalCause): Classification {
  switch (cause.category) {
    case "provider_transport_disconnect":
      return "external_stream_disconnect"
    case "local_lifecycle_close":
      if (cause.subcategory === "unknown_lifecycle_close") return "unknown_scope_close"
      if (cause.subcategory === "instance_reload") return "local_instance_reload"
      if (
        cause.subcategory === "instance_dispose" ||
        cause.subcategory === "instance_dispose_directory" ||
        cause.subcategory === "instance_dispose_all"
      )
        return "local_instance_dispose"
      return "known_lifecycle_close"
    case "request_setup_failure":
      return "request_setup_failure"
    case "tool_execution_failure":
    case "tool_execution_interrupted":
      return "tool_failure"
    default:
      return "unknown_failure"
  }
}

function summarySuffixForIncident(cause: RunIncident.TerminalCause, input: { providerProgressSeen: boolean }) {
  if (cause.category === "provider_transport_disconnect") {
    if (!input.providerProgressSeen) return "transport_failure"
    if (cause.subcategory === "during_tool_input_generation") return "provider_progress_tool_input_disconnect"
    if (cause.boundary === "sdk_transport" && cause.error?.cause_code === "UND_ERR_SOCKET")
      return "provider_progress_socket_closed"
    return "transport_failure"
  }
  if (cause.category === "local_lifecycle_close") {
    if (cause.subcategory === "unknown_lifecycle_close") return "missing_lifecycle_provenance"
    return "lifecycle_close"
  }
  if (cause.category === "request_setup_failure") return "request_setup_failed"
  if (cause.category === "tool_execution_failure" || cause.category === "tool_execution_interrupted")
    return "tool_execution_failed"
  return "unknown"
}

function summarySuffix(input: { failure: Failure | undefined; providerProgressSeen: boolean }) {
  if (input.failure?.type === "transport") {
    const error = safeErrorFingerprint(input.failure.error)
    if (input.providerProgressSeen && error.cause_code === "UND_ERR_SOCKET") return "provider_progress_socket_closed"
    if (input.providerProgressSeen) return "provider_progress_transport_failure"
    return "transport_failure"
  }
  if (input.failure?.type === "scope_closed") {
    if (input.failure.lifecycleActionID) return "lifecycle_close"
    return "missing_lifecycle_provenance"
  }
  if (input.failure?.type === "setup") return "request_setup_failed"
  if (input.failure?.type === "tool") return "tool_execution_failed"
  if (!input.failure) return "completed"
  return "unknown"
}

export function summaryKeyFor(classification: Classification, suffix: string): SummaryKey {
  return `${classification}.${suffix}` as SummaryKey
}

function lifecycleSummary(failure: Failure | undefined): Summary["lifecycle"] {
  if (failure?.type !== "scope_closed" || !failure.lifecycleActionID || !failure.lifecycleKind) return undefined
  return {
    action_id: failure.lifecycleActionID,
    kind: failure.lifecycleKind,
    source: failure.source,
    reason: failure.reason,
    initiated_at: failure.lifecycleInitiatedAt,
    initiated_monotonic_ms: failure.lifecycleInitiatedMonotonicMs,
    affected_directory_keys: [...(failure.lifecycleAffectedDirectoryKeys ?? [])],
    origin: failure.lifecycleOrigin ? { ...failure.lifecycleOrigin } : undefined,
    request: failure.lifecycleRequest ? cloneRequest(failure.lifecycleRequest) : undefined,
  }
}

function earlierLifecycleFailure(
  current: ScopeClosedFailure | undefined,
  next: ScopeClosedFailure,
): ScopeClosedFailure {
  if (!current) return next
  const currentTime = current.lifecycleInitiatedMonotonicMs ?? current.monotonicMs
  const nextTime = next.lifecycleInitiatedMonotonicMs ?? next.monotonicMs
  if (nextTime < currentTime) return next
  return current
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
