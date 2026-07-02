import { batch, createMemo, createRoot, onCleanup, onMount, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { base64Encode } from "@opencode-ai/util/encode"
import { same } from "@/utils/same"
import type { RightPanelStaticTab, RightPanelTab } from "@/pages/session/right-panel-tabs"
import { TERMINAL_TAB_PREFIX } from "@/pages/session/right-panel-tabs"

const emptyTabs: string[] = []

type Tabs = {
  active: Accessor<string | undefined>
  all: Accessor<string[]>
}

type TabsInput = {
  tabs: Accessor<Tabs>
  pathFromTab: (tab: string) => string | undefined
  normalizeTab: (tab: string) => string
  review?: Accessor<boolean>
  hasReview?: Accessor<boolean>
}

export const createSessionTabs = (input: TabsInput) => {
  const review = input.review ?? (() => false)
  const hasReview = input.hasReview ?? (() => false)
  const openedTabs = createMemo(
    () => {
      const seen = new Set<string>()
      return input
        .tabs()
        .all()
        .flatMap((tab) => {
          if (tab === "context" || tab === "review") return []
          const value = input.pathFromTab(tab) ? input.normalizeTab(tab) : tab
          if (seen.has(value)) return []
          seen.add(value)
          return [value]
        })
    },
    emptyTabs,
    { equals: same },
  )
  const activeTab = createMemo(() => {
    const active = input.tabs().active()
    if (active === "review" && review()) return active
    const normalizedActive = active ? input.normalizeTab(active) : undefined
    if (normalizedActive && input.pathFromTab(normalizedActive)) return normalizedActive

    const first = openedTabs()[0]
    if (first) return first
    if (review() && hasReview()) return "review"
    return "empty"
  })
  const activeFileTab = createMemo(() => {
    const active = activeTab()
    if (!openedTabs().includes(active)) return
    return active
  })
  const closableTab = createMemo(() => {
    // File tabs take close priority; shell tabs only apply when no file tab is active.
    const active = input.tabs().active()
    const normalizedActive = active ? input.normalizeTab(active) : undefined
    if (normalizedActive && openedTabs().includes(normalizedActive) && input.pathFromTab(normalizedActive)) {
      return normalizedActive
    }
    const current = activeTab()
    if (openedTabs().includes(current)) return current
    return undefined
  })

  return {
    openedTabs,
    activeTab,
    activeFileTab,
    closableTab,
  }
}

export const focusTerminalById = (id: string) => {
  const wrapper = document.getElementById(`terminal-wrapper-${id}`)
  const terminal = wrapper?.querySelector('[data-component="terminal"]')
  if (!(terminal instanceof HTMLElement)) return false

  const textarea = terminal.querySelector("textarea")
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
    return true
  }

  terminal.focus()
  terminal.dispatchEvent(
    typeof PointerEvent === "function"
      ? new PointerEvent("pointerdown", { bubbles: true, cancelable: true })
      : new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  )
  return true
}

const skip = new Set(["Alt", "Control", "Meta", "Shift"])

export const shouldFocusTerminalOnKeyDown = (event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) => {
  if (skip.has(event.key)) return false
  return !(event.ctrlKey || event.metaKey || event.altKey)
}

export const createOpenReviewFile = (input: {
  showAllFiles: () => void
  tabForPath: (path: string) => string
  openTab: (tab: string) => void
  setActive: (tab: string) => void
  loadFile: (path: string) => any | Promise<void>
}) => {
  return (path: string) => {
    batch(() => {
      input.showAllFiles()
      const maybePromise = input.loadFile(path)
      const open = () => {
        const tab = input.tabForPath(path)
        input.openTab(tab)
        input.setActive(tab)
      }
      if (maybePromise instanceof Promise) maybePromise.then(open)
      else open()
    })
  }
}

export const createOpenSessionFileTab = (input: {
  normalizeTab: (tab: string) => string
  openTab: (tab: string) => void
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  openReviewPanel: () => void
  setActive: (tab: string) => void
}) => {
  return (value: string) => {
    const next = input.normalizeTab(value)
    input.openTab(next)

    const path = input.pathFromTab(next)
    if (!path) return

    input.loadFile(path)
    input.openReviewPanel()
    input.setActive(next)
  }
}

export const getTabReorderIndex = (tabs: readonly string[], from: string, to: string) => {
  const fromIndex = tabs.indexOf(from)
  const toIndex = tabs.indexOf(to)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return undefined
  return toIndex
}

export const sizingStopEvents = ["pointerup", "pointercancel", "mouseup", "touchend", "touchcancel", "blur"] as const

export const createSizing = () => {
  const [state, setState] = createStore({ active: false })
  let t: number | undefined

  const stop = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", false)
  }

  const start = () => {
    if (t !== undefined) {
      clearTimeout(t)
      t = undefined
    }
    setState("active", true)
  }

  onMount(() => {
    for (const event of sizingStopEvents) makeEventListener(window, event, stop)
  })

  onCleanup(() => {
    if (t !== undefined) clearTimeout(t)
  })

  return {
    active: () => state.active,
    start,
    touch() {
      start()
      t = window.setTimeout(stop, 120)
    },
  }
}

export type Sizing = ReturnType<typeof createSizing>

/** Converts right-panel state into the CSS width applied to the shell. */
export function formatRightPanelWidth(open: boolean, width: number): string {
  return open ? `${width}px` : "0px"
}

/** Creates a resize callback that marks user sizing before delegating width storage to layout state. */
export function makeRightPanelResizeHandler(
  size: { touch: () => void },
  layout: { rightPanel: { resize: (width: number) => void } },
): (width: number) => void {
  return (width) => {
    size.touch()
    layout.rightPanel.resize(width)
  }
}

/** Returns whether the Review inner tab row should expose the file-open shortcut. */
export function shouldShowReviewFileOpenButton(activeTab: string | undefined, hasSecondaryTabs: boolean): boolean {
  return hasSecondaryTabs || activeTab !== "review"
}

/** Returns shell tabs that can be reordered by the user. Status is pinned. */
export function sortableShellTabIds(tabs: readonly RightPanelTab[]): RightPanelTab[] {
  return tabs.filter((tab) => tab !== "status")
}

/**
 * Pure decision: given a drag-over event on the right-panel tab strip, return
 * the move action to dispatch, or null for no-op.
 *
 * The rendered strip is two segments concatenated: [pinned status, ...openStatic
 * (closable), ...terminalIds]. Drag-reorder is permitted ONLY within the same
 * segment — cross-segment drag bounces back. Status is pinned (never moved,
 * never a drop target).
 *
 * Indices in the returned action are within that segment's own list:
 *   - kind:"static"  → index into openStatic which still includes "status" at 0;
 *                       moveShellTab clamps `to >= 1` to keep status pinned.
 *   - kind:"terminal" → index into terminalIds (status not present).
 */
export type ShellTabReorderPlan =
  | { kind: "static"; target: RightPanelStaticTab; to: number }
  | { kind: "terminal"; target: string; to: number }

export function planShellTabReorder(input: {
  draggableId: string
  droppableId: string
  openStatic: readonly RightPanelStaticTab[]
  terminalIds: readonly string[]
}): ShellTabReorderPlan | null {
  const { draggableId, droppableId, openStatic, terminalIds } = input
  if (draggableId === droppableId) return null
  if (draggableId === "status" || droppableId === "status") return null

  const fromIsTerminal = draggableId.startsWith(TERMINAL_TAB_PREFIX)
  const toIsTerminal = droppableId.startsWith(TERMINAL_TAB_PREFIX)

  if (fromIsTerminal !== toIsTerminal) return null

  if (fromIsTerminal) {
    const fromId = draggableId.slice(TERMINAL_TAB_PREFIX.length)
    const toId = droppableId.slice(TERMINAL_TAB_PREFIX.length)
    if (!fromId || !toId) return null
    const fromIndex = terminalIds.indexOf(fromId)
    const toIndex = terminalIds.indexOf(toId)
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null
    return { kind: "terminal", target: fromId, to: toIndex }
  }

  // static segment
  const staticList = openStatic as readonly string[]
  const fromIndex = staticList.indexOf(draggableId)
  const toIndex = staticList.indexOf(droppableId)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null
  return {
    kind: "static",
    target: draggableId as RightPanelStaticTab,
    to: toIndex,
  }
}

/** Names the file-opening transition that must activate Review before showing file-specific content. */
export function openReviewShellTab(sidePanel: { openTab: (tab: "review") => void }) {
  sidePanel.openTab("review")
}

/**
 * Wires "the agent attached browser automation" to the side panel: open the
 * browser tab of the DRIVEN conversation — and only that one — so the takeover
 * surfaces where it belongs, never on whichever panel the user happens to be
 * looking at. The broadcast reaches every window, so the layout key is built
 * from the driven session's OWN directory (resolved per event): keying by the
 * viewer's route would mint a dirty `<wrongDir>/<sessionID>` entry whenever the
 * watching window sits on a different project. A session that fails to resolve
 * (deleted mid-flight) opens nothing. No-op unsubscribe on platforms without
 * the embedded browser.
 */
export function subscribeAutomationAttached(
  bridge: { onAutomationAttached(cb: (payload: { sessionID: string }) => void): () => void } | undefined,
  resolveDirectory: (sessionID: string) => Promise<string | undefined>,
  openBrowserTab: (sessionKey: string) => void,
): () => void {
  if (!bridge) return () => {}
  return bridge.onAutomationAttached(({ sessionID }) => {
    void resolveDirectory(sessionID)
      .then((directory) => {
        if (directory) openBrowserTab(`${base64Encode(directory)}/${sessionID}`)
      })
      .catch(() => {})
  })
}

/**
 * Open the browser tab in an arbitrary session's persisted layout state, from
 * outside any component reactive scope (event callbacks, the submit flow).
 * layout.view() builds memos, so it needs its own root; disposal is deferred
 * one microtask so openTab's deferred selection write still runs against live
 * state. `sessionKey` is the layout route key, `<dir>/<sessionID>`.
 */
export function openBrowserTabInSessionLayout(
  layout: { view(sessionKey: string): { sidePanel: { openTab(tab: "browser"): void } } },
  sessionKey: string,
) {
  createRoot((dispose) => {
    layout.view(sessionKey).sidePanel.openTab("browser")
    queueMicrotask(dispose)
  })
}
