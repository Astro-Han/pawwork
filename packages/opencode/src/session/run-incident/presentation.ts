import type { IncidentFacts, RecoveryDecision, TerminalCause } from "./types"

export function userSummary(input: { cause: TerminalCause; recovery: RecoveryDecision }) {
  const prefix = `run_incident.${input.cause.category}`
  const subcategory = "subcategory" in input.cause ? input.cause.subcategory : "unknown"
  return {
    title_key: prefix,
    body_key: `${prefix}.${subcategory}`,
    action_key: actionKey(input.recovery),
    severity: severity(input.cause),
  }
}

export function plainSummary(input: { cause: TerminalCause; facts: IncidentFacts }) {
  if (
    input.cause.category === "provider_transport_disconnect" &&
    input.cause.subcategory === "during_tool_input_generation" &&
    !input.facts.tool_execution_started
  ) {
    return "The provider stream disconnected while PawWork was preparing a tool call. The tool did not run."
  }
  if (input.cause.category === "local_lifecycle_close") {
    return "The active run was interrupted by a local lifecycle close."
  }
  if (input.cause.category === "user_cancel") return "The run was cancelled by the user."
  if (input.cause.category === "watchdog_timeout")
    return "The run stopped after PawWork waited too long for provider progress."
  if (input.cause.category === "tool_execution_failure") return "A tool failed after execution started."
  return "The run ended before PawWork could complete the assistant response."
}

function actionKey(recovery: RecoveryDecision) {
  if (recovery.recommendation === "auto_retry") return "run_incident.action.retry"
  if (recovery.recommendation === "offer_continue") return "run_incident.action.continue"
  if (recovery.recommendation === "offer_resume_with_confirmation") return "run_incident.action.confirm_continue"
  if (recovery.recommendation === "ask_user_before_retry") return "run_incident.action.confirm_retry"
  return undefined
}

function severity(cause: TerminalCause) {
  if (cause.category === "user_cancel") return "info" as const
  if (cause.category === "unknown_interruption" || cause.category === "crash_or_restart_incomplete")
    return "error" as const
  return "warning" as const
}
