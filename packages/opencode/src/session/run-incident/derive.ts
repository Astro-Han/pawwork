import type { MessageID, SessionID } from "../schema"
import type { LifecycleRequest } from "../lifecycle-provenance"
import type { LifecycleKind, RunID, SafeErrorFingerprint, ToolEffectKind } from "../run-observability/types"
import { recoveryFor } from "./policy"
import { plainSummary, userSummary } from "./presentation"
import {
  RUN_INCIDENT_SCHEMA_VERSION,
  type IncidentEvidenceEvent,
  type IncidentFacts,
  type MaterializedToolBoundary,
  type RunIncident,
  type TerminalCause,
} from "./types"
import { sanitizeIncident } from "./sanitize"

export type DeriveIncidentInput = {
  runID: RunID
  traceID: MessageID
  sessionID: SessionID
  messageID: MessageID
  parentMessageID?: MessageID
  createdAt: number
  completedAt?: number
  evidence: IncidentEvidenceEvent[]
  unsafeSideEffectKinds: ToolEffectKind[]
  sideEffectFactsComplete: boolean
  materializedToolBoundaries?: MaterializedToolBoundary[]
  lifecycle?: {
    action_id: string
    kind: LifecycleKind
    source?: string
    reason?: string
    initiated_at?: number
    initiated_monotonic_ms?: number
    affected_directory_keys: string[]
    origin?: { source: string; operation?: string; reason?: string }
    request?: LifecycleRequest
  }
  missingProvenance?: string[]
}

export function deriveIncident(input: DeriveIncidentInput): RunIncident | undefined {
  const terminal = input.evidence
    .filter((event) => event.terminal_candidate && event.cause)
    .sort(compareTerminalEvents)[0]
  if (!terminal?.cause) return undefined
  const facts = factsFromEvidence(input)
  const terminalFacts = terminal.attempt_id ? factsFromEvidence(input, terminal.attempt_id) : facts
  const recovery = recoveryFor({ cause: terminal.cause, facts, terminalFacts })
  const summary = userSummary({ cause: terminal.cause, recovery })
  const missingProvenance = [...(input.missingProvenance ?? []), ...diagnosticGaps(input, terminal, facts)]
  return sanitizeIncident({
    schema_version: RUN_INCIDENT_SCHEMA_VERSION,
    incident_id: `incident:${input.messageID}`,
    run_id: input.runID,
    trace_id: input.traceID,
    session_id: input.sessionID,
    message_id: input.messageID,
    parent_message_id: input.parentMessageID,
    created_at: input.createdAt,
    completed_at: input.completedAt,
    terminal_cause: terminal.cause,
    phase: phaseFor({ facts: terminalFacts, terminalAttemptID: terminal.attempt_id }),
    facts,
    provenance: {
      ...(input.lifecycle
        ? {
            lifecycle: {
              action_id: input.lifecycle.action_id,
              kind: input.lifecycle.kind,
              source: input.lifecycle.source,
              reason: input.lifecycle.reason,
              initiated_at: input.lifecycle.initiated_at,
              initiated_monotonic_ms: input.lifecycle.initiated_monotonic_ms,
              affected_directory_keys: input.lifecycle.affected_directory_keys,
              origin: input.lifecycle.origin,
              request: input.lifecycle.request,
              completeness: "partial" as const,
            },
          }
        : {}),
      completeness: missingProvenance.length ? "partial" : input.lifecycle ? "partial" : "unknown",
    },
    recovery,
    evidence: input.evidence.map(({ cause, ...event }) => event),
    user_summary: summary,
    plain_summary: plainSummary({ cause: terminal.cause, facts }),
    missing_provenance: missingProvenance.length ? missingProvenance : undefined,
    diagnostics_complete: missingProvenance.length === 0,
  })
}

function diagnosticGaps(
  input: DeriveIncidentInput & { evidence: IncidentEvidenceEvent[] },
  terminal: IncidentEvidenceEvent,
  facts: IncidentFacts,
) {
  const gaps: string[] = []
  if (!input.sideEffectFactsComplete) gaps.push("side_effect.boundary_unknown")
  if (terminal.monotonic_ms === undefined) gaps.push("evidence.ordering_missing")
  if (input.lifecycle?.origin?.source === "server_handler" && !input.lifecycle.request)
    gaps.push("lifecycle.request_context_missing")
  if (facts.tool_execution_started && !facts.tool_call_materialized) gaps.push("tool.materialization_missing")
  if (facts.tool_input_completed && !facts.tool_input_started) gaps.push("tool_input.start_missing")
  return Array.from(new Set(gaps))
}

function compareTerminalEvents(left: IncidentEvidenceEvent, right: IncidentEvidenceEvent) {
  const leftTime = left.monotonic_ms ?? Number.POSITIVE_INFINITY
  const rightTime = right.monotonic_ms ?? Number.POSITIVE_INFINITY
  if (leftTime !== rightTime) return leftTime - rightTime
  return left.order - right.order
}

function factsFromEvidence(input: DeriveIncidentInput, attemptID?: IncidentEvidenceEvent["attempt_id"]): IncidentFacts {
  const scopedEvidence = attemptID ? input.evidence.filter((event) => event.attempt_id === attemptID) : input.evidence
  const materializedToolBoundary = summarizeMaterializedToolBoundaries(input.materializedToolBoundaries, attemptID)
  const has = (eventType: string) => scopedEvidence.some((event) => event.event_type === eventType)
  const count = (eventType: string) => scopedEvidence.filter((event) => event.event_type === eventType).length
  return {
    provider_progress_seen: has("provider_progress_seen"),
    visible_output_seen: has("visible_output_seen"),
    text_output_started: has("text_output_started"),
    reasoning_output_started: has("reasoning_output_started"),
    tool_input_started: has("tool_input_started"),
    tool_input_completed: has("tool_input_completed"),
    tool_call_materialized: has("tool_call_materialized"),
    tool_execution_started: has("tool_execution_started"),
    tool_execution_completed: has("tool_execution_completed"),
    read_only_tool_started: has("read_only_tool_started"),
    unsafe_side_effect_started: has("unsafe_side_effect_started"),
    unsafe_side_effect_kinds: attemptID && !has("unsafe_side_effect_started") ? [] : input.unsafeSideEffectKinds,
    materialized_tool_effect_kind: materializedToolBoundary?.effect.kind,
    materialized_tool_requires_confirmation: materializedToolBoundary
      ? materializedToolBoundary.effect.unsafe || !materializedToolBoundary.effect.complete
      : undefined,
    side_effect_facts_complete: input.sideEffectFactsComplete,
    lifecycle_close_seen: has("lifecycle_close_seen"),
    user_cancel_seen: has("user_cancel_seen"),
    watchdog_fired: has("watchdog_fired"),
    pending_tool_parts_interrupted: count("pending_tool_part_interrupted") || undefined,
  }
}

function summarizeMaterializedToolBoundaries(
  boundaries: MaterializedToolBoundary[] | undefined,
  attemptID?: IncidentEvidenceEvent["attempt_id"],
): MaterializedToolBoundary | undefined {
  const scoped = boundaries?.filter((boundary) => !attemptID || boundary.attempt_id === attemptID) ?? []
  if (!scoped.length) return undefined
  return (
    scoped.find((boundary) => !boundary.effect.complete) ??
    scoped.find((boundary) => boundary.effect.unsafe) ??
    scoped[scoped.length - 1]
  )
}

function phaseFor(input: {
  facts: IncidentFacts
  terminalAttemptID?: IncidentEvidenceEvent["attempt_id"]
}): RunIncident["phase"] {
  const toolPhase = input.facts.tool_execution_started
    ? "tool_execution_started"
    : input.facts.tool_call_materialized
      ? "tool_call_materialized"
      : input.facts.tool_input_completed
        ? "tool_input_completed"
        : input.facts.tool_input_started
          ? "tool_input_started"
          : "none"
  const streamPhase = input.facts.tool_call_materialized
    ? "after_tool_call"
    : input.facts.tool_input_completed
      ? "after_tool_input_end"
      : input.facts.tool_input_started
        ? "tool_input_generation"
        : input.facts.reasoning_output_started && !input.facts.text_output_started
          ? "reasoning_generation"
          : input.facts.visible_output_seen || input.facts.provider_progress_seen
            ? "text_generation"
            : "before_first_provider_progress"
  const runPhase = input.facts.tool_execution_started
    ? "tool_execution"
    : input.facts.tool_input_started || input.facts.tool_call_materialized
      ? "tool_generation"
      : input.facts.provider_progress_seen || input.facts.visible_output_seen
        ? "streaming"
        : "unknown"
  return {
    run_phase: runPhase,
    stream_phase: streamPhase,
    tool_phase: toolPhase,
    terminal_attempt_id: input.terminalAttemptID,
  }
}

export function transportCause(input: {
  error?: SafeErrorFingerprint
  providerProgressSeen: boolean
  toolInputStarted: boolean
  toolInputCompleted: boolean
  toolCallMaterialized: boolean
}): Extract<TerminalCause, { category: "provider_transport_disconnect" }> {
  const error = input.error
  const boundary = error?.cause_code === "UND_ERR_SOCKET" ? "sdk_transport" : "unknown"
  return {
    category: "provider_transport_disconnect",
    subcategory:
      input.toolInputStarted && !input.toolInputCompleted && !input.toolCallMaterialized
        ? "during_tool_input_generation"
        : input.toolInputCompleted && !input.toolCallMaterialized
          ? "unknown_stream_phase"
          : input.toolCallMaterialized
            ? "after_tool_call_before_execution"
            : input.providerProgressSeen
              ? "during_text_generation"
              : "before_first_provider_progress",
    boundary,
    error,
    confidence: boundary === "sdk_transport" ? "high" : "medium",
  }
}
