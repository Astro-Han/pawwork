export const promptSelector = '[data-component="prompt-input"]'
// Terminal flatten (Area B 2026-05-25): the right-panel terminal lives inside
// the active `terminal:<id>` Tabs.Content rather than its own `#terminal-panel`
// container. The body element still carries `data-component="terminal-panel"`,
// so scope through that. Kobalte hides inactive Tabs.Content via the `hidden`
// attribute, so this resolves to the currently-active terminal only.
// Mobile has no right panel; the legacy mobile terminal-panel container was
// removed alongside the flatten refactor.
export const terminalSelector =
  '#right-panel[aria-hidden="false"] [data-component="terminal-panel"] [data-component="terminal"]'
export const sessionComposerDockSelector = '[data-component="session-prompt-dock"]'
export const sessionComposerColumnSelector = '[data-component="session-composer-column"]'
export const sessionTimelineColumnSelector = '[data-component="session-timeline-column"]'
export const sessionTurnListSelector = '[data-slot="session-turn-list"]'
export const sessionMessageItemSelector = "[data-message-id]"
export const sessionVirtualizerSelector = '[data-component="session-timeline-virtualizer"]'
export const sessionVirtualRowSelector = '[data-component="session-virtual-row"]'
export const scrollViewSelector = '[data-component="scroll-view"]'
export const scrollViewportSelector = '[data-component="scroll-viewport"]'
export const scrollThumbSelector = '[data-component="scroll-thumb"]'
export const questionDockSelector = '[data-component="dock-prompt"][data-kind="question"]'
export const permissionDockSelector = '[data-component="dock-prompt"][data-kind="permission"]'

export const modelVariantCycleSelector = '[data-action="model-variant-cycle"]'
export const promptAgentSelector = '[data-component="prompt-agent-control"]'
export const promptModelSelector = '[data-component="prompt-model-control"]'
export const promptVariantSelector = '[data-component="prompt-variant-control"]'
export const settingsLanguageSelectSelector = '[data-action="settings-language"]'
export const settingsColorSchemeSelector = '[data-action="settings-color-scheme"]'
export const settingsThemeSelector = '[data-action="settings-theme"]'
export const settingsCodeFontSelector = '[data-action="settings-code-font"]'
export const settingsUIFontSelector = '[data-action="settings-ui-font"]'
export const settingsNotificationsAgentSelector = '[data-action="settings-notifications-agent"]'
export const settingsNotificationsPermissionsSelector = '[data-action="settings-notifications-permissions"]'
export const settingsNotificationsErrorsSelector = '[data-action="settings-notifications-errors"]'
export const settingsSoundsAgentSelector = '[data-action="settings-sounds-agent"]'
export const settingsSoundsPermissionsSelector = '[data-action="settings-sounds-permissions"]'
export const settingsSoundsErrorsSelector = '[data-action="settings-sounds-errors"]'
export const settingsUpdatesStartupSelector = '[data-action="settings-updates-startup"]'
export const settingsReleaseNotesSelector = '[data-action="settings-release-notes"]'
export const desktopShellSelector = '[data-component="desktop-shell"]'
export const desktopShellFrameSelector = '[data-component="desktop-shell-frame"]'
export const desktopShellMainSelector = '[data-component="desktop-shell-main"]'
export const titlebarShellSelector = '[data-component="titlebar-shell"]'
export const titlebarLeftSelector = "#pawwork-titlebar-left"
export const titlebarCenterSelector = "#pawwork-titlebar-center"

const sidebarNavSelector = '[data-component="sidebar-nav-desktop"]'
export const pawworkSidebarSelector = `${sidebarNavSelector} [data-component="pawwork-sidebar"]`
export const pawworkSessionNewSelector = `${sidebarNavSelector} [data-action="pawwork-session-new"]`
export const pawworkSessionSearchSelector = `${sidebarNavSelector} [data-action="pawwork-session-search"]`

export const projectSwitchSelector = (slug: string) =>
  `${sidebarNavSelector} [data-action="project-switch"][data-project="${slug}"]`

export const projectMenuTriggerSelector = (slug: string) =>
  `${sidebarNavSelector} [data-action="project-menu"][data-project="${slug}"]`

export const projectCloseMenuSelector = (slug: string) => `[data-action="project-close-menu"][data-project="${slug}"]`

export const projectWorkspacesToggleSelector = (slug: string) =>
  `[data-action="project-workspaces-toggle"][data-project="${slug}"]`

export const titlebarRightSelector = "#pawwork-titlebar-right"
// Right-panel shell tabs are portalled into the titlebar so the tab strip reads
// as window chrome instead of a second toolbar (see <Titlebar> #pawwork-titlebar-tabs).
// Scoping by data-scope (stamped on the slot) keeps test queries resilient to
// portal-vs-inline rendering.
export const rightPanelTabsScopeSelector = '[data-scope="right-panel"]'
export const sidebarNavMobileSelector = '[data-component="sidebar-nav-mobile"]'

export const popoverBodySelector = '[data-slot="popover-body"]'

export const dropdownMenuContentSelector = '[data-component="dropdown-menu-content"]'
export const contextMenuContentSelector = '[data-component="context-menu-content"]'

export const inlineInputSelector = '[data-component="input"][data-variant="inline"]'

export const sessionItemSelector = (sessionID: string) => `${sidebarNavSelector} [data-session-id="${sessionID}"]`

export const workspaceItemSelector = (slug: string) =>
  `${sidebarNavSelector} [data-component="workspace-item"][data-workspace="${slug}"]`

export const workspaceMenuTriggerSelector = (slug: string) =>
  `${sidebarNavSelector} [data-action="workspace-menu"][data-workspace="${slug}"]`

export const workspaceNewSessionSelector = (slug: string) =>
  `${sidebarNavSelector} [data-action="workspace-new-session"][data-workspace="${slug}"]`

export const listItemSelector = '[data-slot="list-item"]'

export const listItemKeyStartsWithSelector = (prefix: string) => `${listItemSelector}[data-key^="${prefix}"]`

export const listItemKeySelector = (key: string) => `${listItemSelector}[data-key="${key}"]`

export const keybindButtonSelector = (id: string) => `[data-keybind-id="${id}"]`
