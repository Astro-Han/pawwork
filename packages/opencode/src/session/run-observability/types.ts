import { MessageID, SessionID } from "../schema"
import z from "zod"
import type { RunIncident } from "../run-incident"
import type { LifecycleRequest } from "../lifecycle-provenance"

export const SCHEMA_VERSION = 1

export const RunID = z.string().brand<"RunID">()
export type RunID = z.infer<typeof RunID>

export const AttemptID = z.string().brand<"RunAttemptID">()
export type AttemptID = z.infer<typeof AttemptID>

export const Classification = z.enum([
  "success",
  "external_stream_disconnect",
  "local_instance_reload",
  "local_instance_dispose",
  "known_lifecycle_close",
  "unknown_scope_close",
  "request_setup_failure",
  "tool_failure",
  "unknown_failure",
])
export type Classification = z.infer<typeof Classification>

export const SummaryKey = z.string().brand<"RunObservabilitySummaryKey">()
export type SummaryKey = z.infer<typeof SummaryKey>

export type Confidence = "low" | "medium" | "high"

export type RetrySafety = {
  recommendation: "candidate_safe_auto_retry" | "do_not_auto_retry" | "ask_user" | "unknown"
  confidence: Confidence
  reason:
    | "completed_without_failure"
    | "no_visible_output_or_tool_execution"
    | "reasoning_only_without_final_text_or_tool_activity"
    | "visible_output_seen"
    | "tool_execution_started"
    | "unsafe_side_effect_started"
    | "local_abort_or_lifecycle_close"
    | "unknown"
  safety_scope: "user_visible_and_tool_side_effects"
}

export type SafeErrorFingerprint = {
  name?: string
  message?: string
  code?: string
  cause_name?: string
  cause_message?: string
  cause_code?: string
}

export type LifecycleKind =
  | "instance_reload"
  | "instance_dispose"
  | "instance_dispose_directory"
  | "instance_dispose_all"

export type ToolEffectKind = "read_only" | "local_file_write" | "local_process" | "unknown"
export type ToolEffect = {
  kind: ToolEffectKind
  unsafe: boolean
  complete: boolean
}

export type SideEffectBoundarySnapshot = {
  exposed_tool_count: number
  unknown_tool_count: number
  unclassified_effect_count: number
  provider_executed_capability_present: boolean
  external_boundary_present: boolean
  proof_result: "complete" | "incomplete"
  proof_reason:
    | "all_boundaries_classified"
    | "unknown_tool_boundary"
    | "unclassified_effect"
    | "provider_executed_capability"
    | "external_boundary"
    | "unknown"
}

export type AttemptSummary = {
  attempt_id: AttemptID
  attempt_index: number
  started_at: number
  connect_timeout_ms?: number
  last_tool_completed_at?: number
  provider_progress_seen: boolean
  visible_output_seen: boolean
  text_output_started: boolean
  reasoning_output_started: boolean
  tool_call_seen: boolean
  tool_input_started: boolean
  tool_input_completed: boolean
  tool_call_materialized: boolean
  tool_execution_started: boolean
  tool_execution_completed: boolean
  unsafe_side_effect_started: boolean
}

export type Summary = {
  schema_version: typeof SCHEMA_VERSION
  run_id: RunID
  trace_id: MessageID
  session_id: SessionID
  message_id: MessageID
  parent_message_id?: MessageID
  provider: string
  model: string
  created_at: number
  completed_at?: number
  classification: Classification
  summary_key: SummaryKey
  retry_safety: RetrySafety
  attempts: AttemptSummary[]
  terminal_attempt_id?: AttemptID
  provider_progress_seen: boolean
  visible_output_seen: boolean
  tool_call_seen: boolean
  tool_input_started: boolean
  tool_input_completed: boolean
  tool_call_materialized: boolean
  tool_execution_started: boolean
  read_only_tool_started: boolean
  unsafe_side_effect_started: boolean
  unsafe_side_effect_kinds: ToolEffectKind[]
  side_effect_facts_complete: boolean
  side_effect_boundary_snapshot?: SideEffectBoundarySnapshot
  pending_tool_parts_interrupted?: number
  incident?: RunIncident.Summary
  recovered_incidents?: RunIncident.Summary[]
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
  missing_provenance?: string[]
  durations_ms: {
    total?: number
    last_event_to_failure?: number
  }
  error?: SafeErrorFingerprint
}

export type RecorderInput = {
  runID: RunID
  traceID: MessageID
  sessionID: SessionID
  messageID: MessageID
  parentMessageID?: MessageID
  providerID: string
  modelID: string
  createdAt: number
  monotonicStartMs: number
}

export type BeginAttemptInput = {
  attemptIndex: number
  at: number
  monotonicMs: number
  connectTimeoutMs?: number
}

export type Recorder = {
  beginAttempt(input: BeginAttemptInput): { attemptID: AttemptID }
  recordProviderProgress(input: { attemptID: AttemptID; at: number; monotonicMs: number }): void
  recordVisibleOutput(input: {
    attemptID: AttemptID
    at: number
    monotonicMs: number
    kind?: "text" | "reasoning"
  }): void
  recordToolInputStarted(input: {
    attemptID: AttemptID
    at: number
    monotonicMs: number
    providerExecuted?: boolean
  }): void
  recordToolInputCompleted(input: { attemptID: AttemptID; at: number; monotonicMs: number }): void
  recordToolCallMaterialized(input: {
    attemptID: AttemptID
    at: number
    monotonicMs: number
    toolName?: SafeToolName
    effect?: ToolEffect
    providerExecuted?: boolean
  }): void
  recordToolExecutionStarted(input: {
    attemptID: AttemptID
    at: number
    monotonicMs: number
    toolName: SafeToolName
    effect: ToolEffect
  }): void
  recordToolCompleted(input: { attemptID: AttemptID; at: number; monotonicMs: number }): void
  recordToolFailed(input: { attemptID: AttemptID; at: number; monotonicMs: number; error?: unknown }): void
  recordToolInterrupted(input: { attemptID: AttemptID; at: number; monotonicMs: number }): void
  recordPendingToolPartInterrupted(input: {
    attemptID: AttemptID
    at: number
    monotonicMs: number
    interruptionPhase?: RunIncident.EvidenceEvent["interruption_phase"]
    toolExecutionStarted?: boolean
  }): void
  recordSideEffectBoundarySnapshot(input: {
    attemptID?: AttemptID
    at: number
    monotonicMs: number
    snapshot: SideEffectBoundarySnapshot
  }): void
  recordAttemptFailureAndDeriveRecovery(input: {
    attemptID?: AttemptID
    at: number
    monotonicMs: number
    error: unknown
    evidence?: string[]
    watchdog?: { phase: "connect" | "silent_stream" | "unknown" }
    retryable?: boolean
  }): RunIncident.Recovery
  recordAutoRetryAttempted(input: { attemptID: AttemptID; at: number; monotonicMs: number }): void
  recordTransportFailure(input: {
    attemptID?: AttemptID
    at: number
    monotonicMs: number
    error: unknown
    evidence?: string[]
    retryable?: boolean
  }): void
  recordSetupFailure(input: { at: number; monotonicMs: number; error: unknown }): void
  recordScopeClosed(input: {
    at: number
    monotonicMs: number
    source?: string
    reason?: string
    propagationPoint?: string
    lifecycleActionID?: string
    lifecycleKind?: LifecycleKind
    lifecycleInitiatedAt?: number
    lifecycleInitiatedMonotonicMs?: number
    lifecycleAffectedDirectoryKeys?: string[]
    lifecycleOrigin?: { source: string; operation?: string; reason?: string }
    lifecycleRequest?: LifecycleRequest
  }): void
  finalize(input: { completedAt?: number; monotonicMs: number }): Summary
}

export const SafeToolName = z.string().brand<"SafeToolName">()
export type SafeToolName = z.infer<typeof SafeToolName>
