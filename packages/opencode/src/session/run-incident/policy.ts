import { allowsBeforeProgressRetry as boundaryAllowsBeforeProgressRetry } from "../run-observability/boundary"
import { RETRY_INITIAL_DELAY, SAFE_RECOVERY_MAX_ATTEMPTS } from "../retry"
import type { IncidentFacts, RecoveryDecision, TerminalCause } from "./types"

const SAFE_RECOVERY_AUTO_RETRY = {
  max_attempts: SAFE_RECOVERY_MAX_ATTEMPTS,
  backoff_ms: RETRY_INITIAL_DELAY,
} as const

export function recoveryFor(input: {
  cause: TerminalCause
  facts: IncidentFacts
  terminalFacts?: IncidentFacts
  retryable?: boolean
}): RecoveryDecision {
  const base = { safety_scope: "visible_output_and_tool_side_effects" as const }
  const terminalFacts = input.terminalFacts ?? input.facts
  const noToolActivity =
    !terminalFacts.tool_input_started && !terminalFacts.tool_call_materialized && !terminalFacts.tool_execution_started
  const retryableTransport =
    input.retryable === true &&
    (input.cause.category === "provider_transport_disconnect" || input.cause.category === "watchdog_timeout")
  if (input.cause.category === "user_cancel") {
    return { ...base, recommendation: "do_not_retry", confidence: "high", reason: "user_cancel" }
  }
  if (input.cause.category === "local_lifecycle_close") {
    return {
      ...base,
      recommendation: "do_not_retry",
      confidence: input.cause.confidence,
      reason: "local_lifecycle_close",
    }
  }
  if (
    canAutoRetryBeforeFirstProviderProgress({
      cause: input.cause,
      facts: input.facts,
      terminalFacts,
      retryableTransport,
    })
  ) {
    return {
      ...base,
      recommendation: "auto_retry",
      confidence: "high",
      reason: "no_visible_output_or_tool_execution",
      auto_retry: SAFE_RECOVERY_AUTO_RETRY,
    }
  }
  if (isBeforeFirstProviderProgressCause(input.cause) && beforeProgressBoundaryEvidenceBlocksRetry(terminalFacts)) {
    return {
      ...base,
      recommendation: "ask_user_before_retry",
      confidence: "high",
      reason: "side_effect_facts_incomplete",
    }
  }
  if (
    retryableTransport &&
    noToolActivity &&
    !isBeforeFirstProviderProgressCause(input.cause) &&
    terminalFacts.reasoning_output_started &&
    !terminalFacts.text_output_started &&
    !terminalFacts.unsafe_side_effect_started &&
    boundaryAllowsReasoningRetry(terminalFacts)
  ) {
    return {
      ...base,
      recommendation: "auto_retry",
      confidence: "high",
      reason: "reasoning_only_without_final_text_or_tool_activity",
      auto_retry: SAFE_RECOVERY_AUTO_RETRY,
    }
  }
  if (!terminalFacts.side_effect_facts_complete) {
    return {
      ...base,
      recommendation: "ask_user_before_retry",
      confidence: "high",
      reason: "side_effect_facts_incomplete",
    }
  }
  if (
    retryableTransport &&
    noToolActivity &&
    terminalFacts.reasoning_output_started &&
    !terminalFacts.text_output_started
  ) {
    return {
      ...base,
      recommendation: "ask_user_before_retry",
      confidence: "high",
      reason: "side_effect_facts_incomplete",
    }
  }
  if (terminalFacts.unsafe_side_effect_started) {
    return {
      ...base,
      recommendation: "ask_user_before_retry",
      confidence: "high",
      reason: "unsafe_side_effect_started",
    }
  }
  if (terminalFacts.tool_execution_started) {
    return { ...base, recommendation: "ask_user_before_retry", confidence: "medium", reason: "tool_execution_started" }
  }
  if (terminalFacts.tool_call_materialized) {
    if (!terminalFacts.side_effect_facts_complete || terminalFacts.materialized_tool_effect_kind === "unknown") {
      return {
        ...base,
        recommendation: "ask_user_before_retry",
        confidence: "high",
        reason: "side_effect_facts_incomplete",
      }
    }
    if (terminalFacts.materialized_tool_requires_confirmation) {
      return {
        ...base,
        recommendation: "ask_user_before_retry",
        confidence: "high",
        reason: "tool_call_materialized_without_execution",
      }
    }
    return {
      ...base,
      recommendation: "offer_continue",
      confidence: "high",
      reason: "tool_call_materialized_without_execution",
    }
  }
  if (terminalFacts.tool_input_started && !terminalFacts.tool_input_completed) {
    return {
      ...base,
      recommendation: "offer_continue",
      confidence: "high",
      reason: "partial_tool_input_without_execution",
    }
  }
  if (terminalFacts.text_output_started || terminalFacts.visible_output_seen) {
    return {
      ...base,
      recommendation: "offer_continue",
      confidence: "high",
      reason: "visible_output_without_tool_execution",
    }
  }
  if (input.facts.user_cancel_seen) {
    return { ...base, recommendation: "do_not_retry", confidence: "high", reason: "user_cancel" }
  }
  if (input.facts.lifecycle_close_seen) {
    return { ...base, recommendation: "do_not_retry", confidence: "high", reason: "local_lifecycle_close" }
  }
  if (retryableTransport) {
    return {
      ...base,
      recommendation: "auto_retry",
      confidence: "medium",
      reason: "no_visible_output_or_tool_execution",
      auto_retry: SAFE_RECOVERY_AUTO_RETRY,
    }
  }
  return { ...base, recommendation: "unknown", confidence: "low", reason: "unknown" }
}

function canAutoRetryBeforeFirstProviderProgress(input: {
  cause: TerminalCause
  facts: IncidentFacts
  terminalFacts: IncidentFacts
  retryableTransport: boolean
}) {
  if (!input.retryableTransport) return false
  if (input.facts.user_cancel_seen || input.facts.lifecycle_close_seen) return false
  if (!isBeforeFirstProviderProgressCause(input.cause)) return false
  if (input.terminalFacts.provider_progress_seen) return false
  if (!attemptHasNoOutputOrToolActivity(input.terminalFacts)) return false
  return boundaryAllowsBeforeProgressRetry(input.terminalFacts.side_effect_boundary_snapshot)
}

function isBeforeFirstProviderProgressCause(cause: TerminalCause) {
  if (cause.category === "provider_transport_disconnect") return cause.subcategory === "before_first_provider_progress"
  if (cause.category === "watchdog_timeout") return cause.subcategory === "connect"
  return false
}

function attemptHasNoOutputOrToolActivity(facts: IncidentFacts) {
  return (
    !facts.visible_output_seen &&
    !facts.text_output_started &&
    !facts.reasoning_output_started &&
    !facts.tool_input_started &&
    !facts.tool_input_completed &&
    !facts.tool_call_materialized &&
    !facts.tool_execution_started &&
    !facts.tool_execution_completed &&
    !facts.read_only_tool_started &&
    !facts.unsafe_side_effect_started &&
    (facts.pending_tool_parts_interrupted ?? 0) === 0
  )
}

function beforeProgressBoundaryEvidenceBlocksRetry(facts: IncidentFacts) {
  return !boundaryAllowsBeforeProgressRetry(facts.side_effect_boundary_snapshot)
}

function boundaryAllowsReasoningRetry(facts: IncidentFacts) {
  const snapshot = facts.side_effect_boundary_snapshot
  if (!snapshot) return false
  if (snapshot.provider_executed_capability_present) return false
  if (snapshot.external_boundary_present) return false
  if (
    snapshot.proof_reason === "provider_executed_capability" ||
    snapshot.proof_reason === "external_boundary" ||
    snapshot.proof_reason === "unknown"
  ) {
    return false
  }
  return true
}
