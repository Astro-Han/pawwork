import type { Session } from "@opencode-ai/sdk/v2/client"
import type { IconName } from "@opencode-ai/ui/icon"

export type SessionMenuActionID = "pin" | "rename" | "export" | "delete"

export type SessionMenuAction = {
  id: SessionMenuActionID
  label: string
  icon: IconName
  separatorBefore?: boolean
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
      icon: "pin",
      run: () => input.onTogglePinnedSession(input.session.id),
    },
  ]

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
