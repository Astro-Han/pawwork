import type { Session } from "@opencode-ai/sdk/v2/client"
import type { IconName } from "@opencode-ai/ui/icon"

export type SessionMenuActionID = "pin" | "move-up" | "move-down" | "rename" | "export" | "delete"

export type SessionMenuAction = {
  id: SessionMenuActionID
  label: string
  icon: IconName
  separatorBefore?: boolean
  run: () => Promise<void> | void
}

export type MovePinnedDirection = "up" | "down"

export function buildSessionMenuActions(input: {
  session: Session
  pinned: boolean
  /** Index inside the pinned array, when `pinned` is true. Drives whether move-up / move-down show. */
  pinnedIndex?: number
  /** Total count of pinned sessions, when `pinned` is true. Drives whether move-down shows. */
  pinnedCount?: number
  exportAvailable: boolean
  labels: {
    pin: string
    unpin: string
    moveUp: string
    moveDown: string
    rename: string
    export: string
    delete: string
  }
  onTogglePinnedSession: (sessionID: string) => void
  /** Optional. When omitted, move-up / move-down are never offered (mouse-only environments). */
  onMovePinnedSession?: (input: { sessionID: string; direction: MovePinnedDirection }) => void
  onRenameSession: (session: Session) => Promise<void> | void
  onExportSession: (session: Session) => Promise<void> | void
  onDeleteSession: (session: Session) => void
}): SessionMenuAction[] {
  const actions: SessionMenuAction[] = [
    {
      id: "pin",
      label: input.pinned ? input.labels.unpin : input.labels.pin,
      icon: "pin",
      run: () => input.onTogglePinnedSession(input.session.id),
    },
  ]

  const onMove = input.onMovePinnedSession
  const pinnedIndex = input.pinnedIndex
  const pinnedCount = input.pinnedCount
  if (
    input.pinned &&
    onMove &&
    typeof pinnedIndex === "number" &&
    typeof pinnedCount === "number"
  ) {
    if (pinnedIndex > 0) {
      actions.push({
        id: "move-up",
        label: input.labels.moveUp,
        icon: "chevron-up",
        run: () => onMove({ sessionID: input.session.id, direction: "up" }),
      })
    }
    if (pinnedIndex < pinnedCount - 1) {
      actions.push({
        id: "move-down",
        label: input.labels.moveDown,
        icon: "chevron-down",
        run: () => onMove({ sessionID: input.session.id, direction: "down" }),
      })
    }
  }

  actions.push({
    id: "rename",
    label: input.labels.rename,
    icon: "pencil-line",
    run: () => input.onRenameSession(input.session),
  })

  if (input.exportAvailable) {
    actions.push({
      id: "export",
      label: input.labels.export,
      icon: "download",
      run: () => input.onExportSession(input.session),
    })
  }

  actions.push({
    id: "delete",
    label: input.labels.delete,
    icon: "trash",
    separatorBefore: true,
    run: () => input.onDeleteSession(input.session),
  })

  return actions
}
