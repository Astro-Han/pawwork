export function promptKeyActionReady(input: {
  key: string
  working: boolean
  stopping: boolean
  actionReady: boolean
  abortReady: boolean
}) {
  if (input.key === "Escape" && input.working) return input.abortReady
  if (input.key === "Enter" && input.stopping) return input.abortReady
  if (input.key === "Enter" || input.key === "Escape") return input.actionReady
  return input.actionReady
}

export function promptSendDisabled(input: {
  stopping: boolean
  actionReady: boolean
  abortReady: boolean
  blank: boolean
}) {
  if (input.stopping) return !input.abortReady
  return !input.actionReady || input.blank
}
