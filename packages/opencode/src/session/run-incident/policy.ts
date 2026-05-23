import type { IncidentFacts, RecoveryDecision, TerminalCause } from "./types"

export function recoveryFor(input: {
  cause: TerminalCause
  facts: IncidentFacts
  terminalFacts?: IncidentFacts
}): RecoveryDecision {
  const base = { safety_scope: "visible_output_and_tool_side_effects" as const }
  const terminalFacts = input.terminalFacts ?? input.facts
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
  if (!terminalFacts.side_effect_facts_complete) {
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
  if (terminalFacts.visible_output_seen) {
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
  if (input.cause.category === "provider_transport_disconnect" || input.cause.category === "watchdog_timeout") {
    return {
      ...base,
      recommendation: "auto_retry_once",
      confidence: "medium",
      reason: "no_visible_output_or_tool_execution",
      auto_retry: { max_attempts: 1, backoff_ms: 1_000 },
    }
  }
  return { ...base, recommendation: "unknown", confidence: "low", reason: "unknown" }
}
