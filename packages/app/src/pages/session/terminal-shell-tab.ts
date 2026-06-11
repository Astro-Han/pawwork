import type { RightPanelTab } from "@/pages/session/right-panel-tabs"
import {
  isRightPanelTerminalTab,
  terminalTabId,
  terminalTabValue,
} from "@/pages/session/right-panel-tabs"
import type { TerminalTabID } from "@/context/terminal-types"

/**
 * Minimal slice of the right-panel side-panel API that the desktop terminal
 * helpers need. Kept structural so the real `view().sidePanel` from layout
 * context (which has many more members) and small test fakes both satisfy it.
 */
type SidePanelSlice = {
  opened: () => boolean
  tab: () => RightPanelTab
  openTab: (tab: RightPanelTab) => void
  closeTab: (tab: RightPanelTab) => void
  close: () => void
}

type TerminalSlice = {
  active: () => string | undefined
  all: () => { tabID: TerminalTabID }[]
  new: () => void
  close: (id: TerminalTabID) => void
}

/**
 * After flatten, "show a terminal" always means "activate its outer right-
 * panel tab". This picks the right terminal id (current active, else first)
 * and switches sidePanel to it. No-op when there are no terminals — callers
 * that want auto-creation must invoke `terminal.new()` first themselves so
 * the intent ("create or focus") stays explicit at the call site.
 */
export function focusActiveTerminalTab(
  sidePanel: Pick<SidePanelSlice, "openTab">,
  terminal: Pick<TerminalSlice, "active" | "all">,
) {
  const id = terminal.active() ?? terminal.all()[0]?.tabID
  if (!id) return
  sidePanel.openTab(terminalTabValue(id as string))
}

/**
 * Toggle the right-panel terminal experience on desktop:
 *   - if a terminal tab is currently active → close the panel,
 *   - else if any terminal exists → switch to it,
 *   - else → create a new terminal and switch to it.
 *
 * Terminals flatten into right-panel tabs (Area B 2026-05-25); there is no
 * separate "Terminal" panel surface to toggle anymore.
 *
 * Note: terminal.new() is currently a synchronous batch on the SolidJS store,
 * so focusActiveTerminalTab reading terminal.active() right after returns the
 * new id. If terminal.new becomes async (e.g. backend handshake) that read
 * must become awaited — flagged here so the assumption is visible.
 */
export function toggleDesktopTerminal(
  view: { sidePanel: Pick<SidePanelSlice, "opened" | "tab" | "openTab" | "close"> },
  terminal: Pick<TerminalSlice, "active" | "all" | "new">,
) {
  const onTerminal = view.sidePanel.opened() && isRightPanelTerminalTab(view.sidePanel.tab())
  if (onTerminal) {
    view.sidePanel.close()
    return
  }
  if (terminal.all().length === 0) terminal.new()
  focusActiveTerminalTab(view.sidePanel, terminal)
}

/**
 * Return a unified close handler for a shell tab. Routes terminal:<id> closes
 * to terminal.close (and shifts focus to the previous terminal in render
 * order, or back to status if the closed terminal was the first); static-tab
 * closes go straight to sidePanel.closeTab.
 *
 * Used by both the mouse-driven close on each chip and the keyboard mod+w
 * shortcut so the two paths stay identical — earlier they diverged and mod+w
 * left orphan terminals in terminal.all().
 *
 * Deps are passed as accessors so the router survives session-route changes
 * (view()/terminal context identity can flip when navigating between
 * sessions, but the router instance is created once per consumer).
 */
export function createCloseShellTabRouter(deps: {
  view: () => { sidePanel: Pick<SidePanelSlice, "tab" | "openTab" | "closeTab"> }
  terminal: () => Pick<TerminalSlice, "all" | "close">
  /** Desktop only: the embedded browser's close gesture destroys its page
   *  (see createBrowserTabClose), so it routes through a flow that may confirm
   *  first. Both consumers must pass the same flow — that is exactly why this
   *  lives in the router both paths share. Absent on web, where the browser
   *  tab is never offered. */
  closeBrowserTab?: () => void
}) {
  return (tab: RightPanelTab) => {
    const sidePanel = deps.view().sidePanel
    if (tab === "browser" && deps.closeBrowserTab) {
      deps.closeBrowserTab()
      return
    }
    if (!isRightPanelTerminalTab(tab)) {
      sidePanel.closeTab(tab)
      return
    }
    const closingId = terminalTabId(tab)
    const wasActive = sidePanel.tab() === tab
    const term = deps.terminal()
    const ids = term.all().map((t) => t.tabID as string)
    const closingIndex = ids.indexOf(closingId)
    term.close(closingId as TerminalTabID)
    if (!wasActive) return
    // Fall focus to the previous terminal in render order; when the closed one
    // was the first, fall to the next terminal instead. Only hand back to
    // status when no sibling terminal remains. Matches editor/browser
    // convention: closing a tab focuses its previous sibling, or the next one
    // when there is no previous, and never ejects you from the tab group while
    // siblings exist. `ids` is the pre-close snapshot, so index ±1 are the
    // surviving neighbors.
    const nextId = ids[closingIndex - 1] ?? ids[closingIndex + 1]
    if (nextId) {
      sidePanel.openTab(terminalTabValue(nextId))
    } else {
      sidePanel.closeTab(tab) // no sibling terminals left → shifts active off the dead terminal
    }
  }
}
