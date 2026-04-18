export type RightPanelTab = "status" | "files" | "review" | "terminal"

export const migrateLegacyRightPanelTab = (tab?: string): RightPanelTab => {
  if (tab === "changes") return "review"
  if (tab === "files") return "files"
  if (tab === "review" || tab === "status" || tab === "terminal") return tab
  return "status"
}

export const defaultRightPanelTab = (tab?: string) => migrateLegacyRightPanelTab(tab)
