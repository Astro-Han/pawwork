import type { SettingsTab } from "@/pages/settings/settings-shell"

// Module-level handle so non-shell code (e.g. Toast actions from the connection
// health monitor) can open the settings surface on a specific tab. Mirrors the
// notification-click `setNavigate` pattern.
let openImpl: ((tab?: SettingsTab) => void) | undefined

export const setOpenSettings = (fn: (tab?: SettingsTab) => void) => {
  openImpl = fn
}

export const openSettingsTab = (tab?: SettingsTab) => {
  openImpl?.(tab)
}
