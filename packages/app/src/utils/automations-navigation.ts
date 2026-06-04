// Module-level handle so non-shell code (e.g. the automate tool card rendered
// deep in the message thread) can open the Automations surface focused on one
// automation. Mirrors the settings-navigation `setOpenSettings` pattern.
let openImpl: ((automationID?: string) => void) | undefined

export const setOpenAutomations = (fn: (automationID?: string) => void) => {
  openImpl = fn
}

export const openAutomation = (automationID?: string) => {
  openImpl?.(automationID)
}
