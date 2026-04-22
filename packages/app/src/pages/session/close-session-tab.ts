import { RIGHT_PANEL_TAB_META, type RightPanelTab } from "@/pages/session/right-panel-tabs"

type CloseSessionTabInput = {
  closableTab: () => string | undefined
  closeFileTab: (tab: string) => void
  sidePanelOpened: () => boolean
  sidePanelTab: () => RightPanelTab
  closeShellTab: (tab: RightPanelTab) => void
}

export function canCloseSessionTab(
  closableTab: () => string | undefined,
  sidePanelOpened: () => boolean,
  sidePanelTab: () => RightPanelTab,
): boolean {
  return !!closableTab() || (sidePanelOpened() && RIGHT_PANEL_TAB_META[sidePanelTab()].closable)
}

/** Closes the active closable tab: file tabs first, then non-status shell tabs. */
export function closeSessionTab(input: CloseSessionTabInput): boolean {
  const fileTab = input.closableTab()
  if (fileTab) {
    input.closeFileTab(fileTab)
    return true
  }

  const shellTab = input.sidePanelTab()
  if (!input.sidePanelOpened() || !RIGHT_PANEL_TAB_META[shellTab].closable) return false
  input.closeShellTab(shellTab)
  return true
}
