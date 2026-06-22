import type { MessageID, SessionID } from "../schema"
import type {
  AttemptID,
  LifecycleKind,
  RunID,
  SafeErrorFingerprint,
  SafeToolName,
  SideEffectBoundarySnapshot,
  ToolEffect,
  ToolEffectKind,
} from "../run-observability/types"
import type { LifecycleRequest } from "../lifecycle-provenance"
import type { ProviderApiErrorKind } from "@/provider/error"

// v2: added the provider_api_error terminal cause (a provider returned an
// API-level rejection rather than the connection dropping).
export const RUN_INCIDENT_SCHEMA_VERSION = 2

export type Confidence = "low" | "medium" | "high"

export type IncidentEvidenceSource =
  | "provider_stream"
  | "processor"
  | "tool_runner"
  | "lifecycle"
  | "watchdog"
  | "user_action"
  | "recovery"
  | "unknown"

export type IncidentEvidenceEvent = {
  event_id: string
  order: number
  omitted_events?: number
  monotonic_ms?: number
  source: IncidentEvidenceSource
  attempt_id?: AttemptID
  event_type: string
  terminal_candidate: boolean
  confidence: Confidence
  error?: SafeErrorFingerprint
  redactions?: string[]
  cause?: TerminalCause
  tool_name?: SafeToolName
  tool_effect_kind?: ToolEffectKind
  tool_effect_unsafe?: boolean
  tool_effect_complete?: boolean
  side_effect_boundary_snapshot?: SideEffectBoundarySnapshot
  interruption_phase?: "tool_input_generation" | "tool_call_materialized_without_execution" | "tool_execution"
  tool_execution_started?: boolean
}

export type IncidentEvidenceSummary = Omit<IncidentEvidenceEvent, "cause">

export type TerminalCause =
  | {
      category: "provider_transport_disconnect"
      subcategory:
        | "before_first_provider_progress"
        | "during_text_generation"
        | "during_tool_input_generation"
        | "after_tool_call_before_execution"
        | "after_tool_result"
        | "unknown_stream_phase"
      boundary?: "sdk_transport" | "provider" | "network" | "unknown"
      error?: SafeErrorFingerprint
      confidence: Confidence
    }
  | {
      category: "provider_api_error"
      subcategory: ProviderApiErrorKind
      retryable?: boolean
      error?: SafeErrorFingerprint
      confidence: Confidence
    }
  | {
      category: "local_lifecycle_close"
      subcategory: LifecycleKind | "unknown_lifecycle_close"
      confidence: "medium" | "high"
    }
  | { category: "user_cancel"; confidence: "medium" | "high" }
  | {
      category: "watchdog_timeout"
      subcategory: "connect" | "silent_stream" | "unknown"
      confidence: "medium" | "high"
    }
  | { category: "request_setup_failure"; error?: SafeErrorFingerprint; confidence: "medium" | "high" }
  | {
      category: "tool_execution_failure"
      tool?: SafeToolName
      error?: SafeErrorFingerprint
      confidence: "medium" | "high"
    }
  | { category: "tool_execution_interrupted"; tool?: SafeToolName; confidence: "medium" | "high" }
  | { category: "crash_or_restart_incomplete"; confidence: Confidence }
  | { category: "unknown_interruption"; confidence: "low" }

export type IncidentPhase = {
  run_phase:
    | "before_provider_stream"
    | "streaming"
    | "tool_generation"
    | "tool_execution"
    | "post_tool"
    | "finalizing"
    | "unknown"
  stream_phase?:
    | "before_first_event"
    | "before_first_provider_progress"
    | "text_generation"
    | "reasoning_generation"
    | "tool_input_generation"
    | "after_tool_input_end"
    | "after_tool_call"
    | "completed"
    | "unknown"
  tool_phase?:
    | "none"
    | "tool_input_started"
    | "tool_input_completed"
    | "tool_call_materialized"
    | "tool_execution_started"
    | "tool_execution_completed"
    | "unknown"
  terminal_attempt_id?: AttemptID
}

export type IncidentFacts = {
  provider_progress_seen: boolean
  visible_output_seen: boolean
  text_output_started: boolean
  reasoning_output_started: boolean
  tool_input_started: boolean
  tool_input_completed: boolean
  tool_call_materialized: boolean
  tool_execution_started: boolean
  tool_execution_completed: boolean
  read_only_tool_started: boolean
  unsafe_side_effect_started: boolean
  unsafe_side_effect_kinds: ToolEffectKind[]
  materialized_tool_effect_kind?: ToolEffectKind
  materialized_tool_requires_confirmation?: boolean
  side_effect_facts_complete: boolean
  side_effect_boundary_snapshot?: SideEffectBoundarySnapshot
  lifecycle_close_seen: boolean
  user_cancel_seen: boolean
  watchdog_fired: boolean
  pending_tool_parts_interrupted?: number
}

export type IncidentProvenance = {
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
    completeness: "complete" | "partial" | "unknown"
  }
  interrupt?: {
    source?: string
    reason?: string
    propagation_point?: string
    recorded_at?: number
  }
  completeness: "complete" | "partial" | "unknown"
}

export type MaterializedToolBoundary = {
  attempt_id?: AttemptID
  tool?: SafeToolName
  effect: ToolEffect
}

export type RecoveryDecision = {
  recommendation:
    | "auto_retry"
    | "offer_continue"
    | "offer_resume_with_confirmation"
    | "ask_user_before_retry"
    | "do_not_retry"
    | "unknown"
  confidence: Confidence
  reason:
    | "no_visible_output_or_tool_execution"
    | "reasoning_only_without_final_text_or_tool_activity"
    | "visible_output_without_tool_execution"
    | "partial_tool_input_without_execution"
    | "tool_call_materialized_without_execution"
    | "read_only_tool_completed"
    | "tool_execution_started"
    | "unsafe_side_effect_started"
    | "side_effect_facts_incomplete"
    | "local_lifecycle_close"
    | "user_cancel"
    | "provider_api_error"
    | "unknown"
  auto_retry?: { max_attempts: number; backoff_ms: number; attempted_at?: number }
  user_action?: { kind: "continue" | "resume" | "retry" | "confirm_continue" | "dismiss"; idempotency_key: string }
  safety_scope: "visible_output_and_tool_side_effects"
}

export type RunIncident = {
  schema_version: typeof RUN_INCIDENT_SCHEMA_VERSION
  incident_id: string
  run_id: RunID
  trace_id: MessageID
  session_id: SessionID
  message_id: MessageID
  parent_message_id?: MessageID
  created_at: number
  completed_at?: number
  terminal_cause: TerminalCause
  phase: IncidentPhase
  facts: IncidentFacts
  provenance: IncidentProvenance
  recovery: RecoveryDecision
  evidence?: IncidentEvidenceSummary[]
  user_summary: {
    title_key: string
    body_key: string
    action_key?: string
    severity: "info" | "warning" | "error"
  }
  plain_summary: string
  missing_provenance?: string[]
  diagnostics_complete: boolean
}

export type ExportIncidentChain = {
  incident_id: string
  run_id: RunID
  session_id: SessionID
  message_id: MessageID
  terminal_cause_category: TerminalCause["category"]
  terminal_cause_subcategory?: string
  run_phase: IncidentPhase["run_phase"]
  stream_phase?: IncidentPhase["stream_phase"]
  tool_phase?: IncidentPhase["tool_phase"]
  recovery_recommendation: RecoveryDecision["recommendation"]
  nearest_origin?: { source: string; operation?: string; reason?: string }
  nearest_request?: LifecycleRequest
  missing_provenance?: string[]
  diagnostics_complete: boolean
  plain_summary: string
}
