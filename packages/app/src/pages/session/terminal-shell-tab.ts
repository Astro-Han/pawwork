import type { RightPanelTab } from "@/pages/session/right-panel-tabs"
import {
  isRightPanelTerminalTab,
  terminalTabId,
  terminalTabValue,
} from "@/pages/session/right-panel-tabs"
import type { TerminalTabID } from "@/context/terminal-types"

type DesktopTerminalView = {
  sidePanel: {
    opened: () => boolean
    tab: () => RightPanelTab
    openTab: (tab: RightPanelTab) => void
    close: () => void
  }
}

type DesktopTerminalState = {
  /** Currently active terminal tab id, or undefined if none. */
  active: () => string | undefined
  /** All terminal tab ids in order. */
  all: () => { tabID: TerminalTabID }[]
  /** Create a new terminal; sets it active. */
  new: () => void
}

/**
 * Toggle the right-panel terminal experience on desktop:
 *   - if a terminal tab is currently active → close the panel,
 *   - else if any terminal exists → switch to the active terminal tab,
 *   - else → create a new terminal and switch to it.
 *
 * Terminals flatten into right-panel tabs (Area B 2026-05-25); there is no
 * separate "Terminal" panel surface to toggle anymore.
 *
 * Note: terminal.new() is currently a synchronous batch on the SolidJS store,
 * so reading terminal.active() immediately after returns the new id. If
 * terminal.new becomes async (e.g. backend handshake), the post-new read must
 * become awaited instead — flagged here so the assumption is visible.
 */
export function toggleDesktopTerminal(view: DesktopTerminalView, terminal: DesktopTerminalState) {
  const currentTab = view.sidePanel.tab()
  const isOnTerminal = view.sidePanel.opened() && isRightPanelTerminalTab(currentTab)

  if (isOnTerminal) {
    view.sidePanel.close()
    return
  }

  const activeId = terminal.active()
  if (activeId) {
    view.sidePanel.openTab(terminalTabValue(activeId))
    return
  }

  const first = terminal.all()[0]
  if (first) {
    view.sidePanel.openTab(terminalTabValue(first.tabID))
    return
  }

  terminal.new()
  const newId = terminal.active()
  if (newId) view.sidePanel.openTab(terminalTabValue(newId))
}

type ShellCloseRouter = {
  view: {
    sidePanel: {
      tab: () => RightPanelTab
      openTab: (tab: RightPanelTab) => void
      closeTab: (tab: RightPanelTab) => void
    }
  }
  terminal: {
    all: () => { tabID: TerminalTabID }[]
    close: (id: TerminalTabID) => void
  }
}

/**
 * Return a unified close handler for a shell tab. Routes terminal:<id> closes
 * to terminal.close (and falls focus to a neighbor terminal in render order
 * before fading back to status), and static-tab closes to view.sidePanel.closeTab.
 *
 * Used by both the mouse-driven close on each chip and the keyboard mod+w
 * shortcut so the two paths stay identical — earlier these diverged and
 * mod+w left orphan terminals in terminal.all().
 */
export function createCloseShellTabRouter({ view, terminal }: ShellCloseRouter) {
  return (tab: RightPanelTab) => {
    if (!isRightPanelTerminalTab(tab)) {
      view.sidePanel.closeTab(tab)
      return
    }
    const closingId = terminalTabId(tab)
    const wasActive = view.sidePanel.tab() === tab
    const ids = terminal.all().map((t) => t.tabID as string)
    const closingIndex = ids.indexOf(closingId)
    terminal.close(closingId as TerminalTabID)
    if (!wasActive) return
    // Fall focus to the previous terminal in render order; if it was the
    // first (or only) terminal, hand back to status. Matches editor / browser
    // convention "close current → go to previous sibling".
    const nextId = closingIndex > 0 ? ids[closingIndex - 1] : undefined
    if (nextId) {
      view.sidePanel.openTab(terminalTabValue(nextId))
    } else {
      view.sidePanel.closeTab(tab) // shifts active off the dead terminal
    }
  }
}
