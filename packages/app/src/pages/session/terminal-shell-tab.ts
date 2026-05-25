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
}) {
  return (tab: RightPanelTab) => {
    const sidePanel = deps.view().sidePanel
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
    // Fall focus to the previous terminal in render order; if it was the
    // first (or only) terminal, hand back to status. Matches editor/browser
    // convention "close current → go to previous sibling".
    const nextId = closingIndex > 0 ? ids[closingIndex - 1] : undefined
    if (nextId) {
      sidePanel.openTab(terminalTabValue(nextId))
    } else {
      sidePanel.closeTab(tab) // shifts active off the dead terminal
    }
  }
}
