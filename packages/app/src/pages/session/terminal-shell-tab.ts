import type { RightPanelTab } from "@/pages/session/right-panel-tabs"

type DesktopTerminalView = {
  sidePanel: {
    opened: () => boolean
    tab: () => RightPanelTab
    toggleTab: (tab: "terminal") => void
  }
}

type DesktopTerminal = {
  open: () => void
  close: () => void
}

export function toggleDesktopTerminal(view: DesktopTerminalView, terminal: DesktopTerminal) {
  const open = view.sidePanel.opened() && view.sidePanel.tab() === "terminal"
  view.sidePanel.toggleTab("terminal")
  // Apply terminal state immediately for responsive UI feedback; session-side-panel keeps it synchronized idempotently.
  if (open) terminal.close()
  else terminal.open()
}
