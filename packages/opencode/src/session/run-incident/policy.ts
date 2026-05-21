import type { IncidentFacts, RecoveryDecision, TerminalCause } from "./types"

export function recoveryFor(input: { cause: TerminalCause; facts: IncidentFacts }): RecoveryDecision {
  const base = { safety_scope: "visible_output_and_tool_side_effects" as const }
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
  if (!input.facts.side_effect_facts_complete) {
    return {
      ...base,
      recommendation: "ask_user_before_retry",
      confidence: "high",
      reason: "side_effect_facts_incomplete",
    }
  }
  if (input.facts.unsafe_side_effect_started) {
    return {
      ...base,
      recommendation: "ask_user_before_retry",
      confidence: "high",
      reason: "unsafe_side_effect_started",
    }
  }
  if (input.facts.tool_execution_started) {
    return { ...base, recommendation: "ask_user_before_retry", confidence: "medium", reason: "tool_execution_started" }
  }
  if (input.facts.tool_call_materialized) {
    return {
      ...base,
      recommendation: "offer_continue",
      confidence: "high",
      reason: "tool_call_materialized_without_execution",
    }
  }
  if (input.facts.tool_input_started && !input.facts.tool_input_completed) {
    return {
      ...base,
      recommendation: "offer_continue",
      confidence: "high",
      reason: "partial_tool_input_without_execution",
    }
  }
  if (input.facts.visible_output_seen) {
    return {
      ...base,
      recommendation: "offer_continue",
      confidence: "high",
      reason: "visible_output_without_tool_execution",
    }
  }
  if (input.cause.category === "provider_transport_disconnect") {
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
