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
  restoreState: "applied" | "undone" | "redo_invalidated"
}

type TurnChangeBase = {
  sessionID: string
  turnID?: string
  messageID?: string
  truncated?: boolean
  omittedCount?: number
  skippedCount?: number
}

export type CapturedTurnChange = TurnChangeBase & {
  kind: "captured" | "mixed"
  count?: number
  files: TurnChangeFile[]
}

export type TurnChangeDisplay =
  | (TurnChangeBase & { kind: "empty" })
  | (TurnChangeBase & { kind: "uncaptured"; count: number })
  | CapturedTurnChange

export type TurnChangeActions = {
  undo?: (userMessageID: string, options?: { force?: boolean }) => Promise<TurnChangeDisplay | undefined> | void
  redo?: (userMessageID: string, options?: { force?: boolean }) => Promise<TurnChangeDisplay | undefined> | void
  openFile?: (path: string) => void
  showInFolder?: (path: string) => void
}

const emptyTurnChangeFiles: readonly TurnChangeFile[] = []

// Tag narrowing for the wire union is centralized here so panel / hooks / tests
// stay tag-agnostic. New file-bearing variants only need to opt in inside this helper.
export function turnChangeFiles(display: TurnChangeDisplay | null | undefined): readonly TurnChangeFile[] {
  if (!display) return emptyTurnChangeFiles
  if (display.kind === "captured" || display.kind === "mixed") return display.files
  return emptyTurnChangeFiles
}

export function hasVisibleTurnChanges(display: TurnChangeDisplay | null | undefined) {
  if (!display) return false
  return turnChangeFiles(display).length > 0 || !!display.truncated
}

// After a force-partial undo a turn can have hasApplied (skipped messages still applied)
// and hasUndone (succeeded messages) at the same time. We surface a single button that
// continues in the original direction (undo) by design; the redo path for a mixed state
// is intentionally not exposed inline. Mixed-state recovery UX is tracked as follow-up.
export function turnChangeAction(display: TurnChangeDisplay | null | undefined): "undo" | "redo" | undefined {
  const files = turnChangeFiles(display)
  if (files.some((file) => file.restoreState === "applied")) return "undo"
  if (files.some((file) => file.restoreState === "undone")) return "redo"
}

export function hasTurnChangeActionHandler(
  display: TurnChangeDisplay | null | undefined,
  actions: TurnChangeActions | null | undefined,
) {
  const action = turnChangeAction(display)
  if (action === "undo") return typeof actions?.undo === "function"
  if (action === "redo") return typeof actions?.redo === "function"
  return false
}
