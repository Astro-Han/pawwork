export function promptKeyActionReady(input: {
  key: string
  working: boolean
  actionReady: boolean
  abortReady: boolean
}) {
  // ESC is the keyboard interrupt: gate it on abort readiness while working.
  // Enter only ever submits, so it always follows submit readiness.
  if (input.key === "Escape" && input.working) return input.abortReady
  if (input.key === "Enter" || input.key === "Escape") return input.actionReady
  return true
}

export function shouldActivateShellModeFromBang(input: {
  cursorPosition: number
  mode: "normal" | "shell"
  actionReady: boolean
}) {
  return input.actionReady && input.mode === "normal" && input.cursorPosition === 0
}

export function shouldExitShellModeOnBackspace(input: {
  mode: "normal" | "shell"
  collapsed: boolean
  cursorPosition: number
  textLength: number
  actionReady: boolean
}) {
  return (
    input.actionReady &&
    input.mode === "shell" &&
    input.collapsed &&
    input.cursorPosition === 0 &&
    input.textLength === 0
  )
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
