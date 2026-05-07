import type { Session } from "@opencode-ai/sdk/v2/client"

export type SessionMenuActionID = "pin" | "rename" | "export" | "delete"

export type SessionMenuAction = {
  id: SessionMenuActionID
  label: string
  separatorBefore?: boolean
  shortcut?: string
  run: () => Promise<void> | void
}

export function buildSessionMenuActions(input: {
  session: Session
  pinned: boolean
  exportAvailable: boolean
  labels: {
    pin: string
    unpin: string
    rename: string
    export: string
    delete: string
  }
  onTogglePinnedSession: (sessionID: string) => void
  onRenameSession: (session: Session) => Promise<void> | void
  onExportSession: (session: Session) => Promise<void> | void
  onDeleteSession: (session: Session) => void
}): SessionMenuAction[] {
  const actions: SessionMenuAction[] = [
    {
      id: "pin",
      label: input.pinned ? input.labels.unpin : input.labels.pin,
      run: () => input.onTogglePinnedSession(input.session.id),
    },
    {
      id: "rename",
      label: input.labels.rename,
      shortcut: "↵",
      run: () => input.onRenameSession(input.session),
    },
  ]

  if (input.exportAvailable) {
    actions.push({
      id: "export",
      label: input.labels.export,
      run: () => input.onExportSession(input.session),
    })
  }

  actions.push({
    id: "delete",
    label: input.labels.delete,
    separatorBefore: true,
    shortcut: "⌫",
    run: () => input.onDeleteSession(input.session),
  })

  return actions
}
