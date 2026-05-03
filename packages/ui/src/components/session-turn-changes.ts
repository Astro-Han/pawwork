export type TurnChangeFile = {
  path: string
  openPath?: string
  status: "added" | "modified" | "deleted"
  additions?: number
  deletions?: number
  patch?: string
  sensitive?: boolean
  binary?: boolean
  large?: boolean
  restoreAvailable?: boolean
  expandable: boolean
}

export type TurnChangeDisplay = {
  sessionID: string
  turnID: string
  messageID: string
  undoAvailable: boolean
  redoAvailable: boolean
  truncated?: boolean
  omittedCount?: number
  files: TurnChangeFile[]
}

export function hasVisibleTurnChanges(display: TurnChangeDisplay | null | undefined) {
  return !!display && (display.files.length > 0 || !!display.truncated)
}

export function turnChangeAction(display: TurnChangeDisplay | null | undefined): "undo" | "redo" | undefined {
  if (display?.undoAvailable) return "undo"
  if (display?.redoAvailable) return "redo"
}

export function hasTurnChangeActionHandler(
  display: TurnChangeDisplay | null | undefined,
  actions: { undo?: unknown; redo?: unknown } | null | undefined,
) {
  const action = turnChangeAction(display)
  if (action === "undo") return typeof actions?.undo === "function"
  if (action === "redo") return typeof actions?.redo === "function"
  return false
}
