/**
 * Right-side panel tab value space.
 *
 * Two arms:
 *   1. RightPanelStaticTab — the three fixed slots (status / review / context).
 *      Persisted in openShellTabs by name.
 *   2. `terminal:<id>` — one dynamic tab per live terminal. The id is the
 *      TerminalTabID from the terminal context. These are NOT persisted in
 *      openShellTabs; they are merged in at render time from terminal.all().
 *
 * Pre-flatten, "terminal" was a fixed slot containing an internal multi-terminal
 * strip. After flatten (Area B, 2026-05-25) each terminal is its own outer tab,
 * sibling of files/review/context. Legacy persistence with "terminal" as a fixed
 * slot is dropped via migrateLegacyRightPanelTab / coerceLegacySidePanelTab.
 */

export type RightPanelStaticTab = "status" | "review" | "context"
export type RightPanelTerminalTab = `terminal:${string}`
export type RightPanelTab = RightPanelStaticTab | RightPanelTerminalTab

export const RIGHT_PANEL_TAB_VALUES: readonly RightPanelStaticTab[] = [
  "status",
  "review",
  "context",
] as const

export type RightPanelShellIconName = "status" | "review" | "terminal"

export type ShellTabIcon =
  | { kind: "icon"; name: RightPanelShellIconName }
  | { kind: "indicator"; fallbackIcon: RightPanelShellIconName }

export type RightPanelTabLabelKey =
  | "status.popover.trigger"
  | "session.tab.review"
  | "session.tab.context"

export interface RightPanelTabMeta {
  icon: ShellTabIcon
  labelKey: RightPanelTabLabelKey
  commandId?: string
  closable: boolean
}

/** Static-tab metadata only. Terminal tabs derive their meta from terminal state. */
export const RIGHT_PANEL_TAB_META: Record<RightPanelStaticTab, RightPanelTabMeta> = {
  status: { icon: { kind: "icon", name: "status" }, labelKey: "status.popover.trigger", closable: false },
  review: {
    icon: { kind: "icon", name: "review" },
    labelKey: "session.tab.review",
    commandId: "review.toggle",
    closable: true,
  },
  context: {
    icon: { kind: "indicator", fallbackIcon: "status" },
    labelKey: "session.tab.context",
    closable: true,
  },
}

/** Shared prefix for dynamic `terminal:<id>` tab values. Imported by helpers
 *  that parse or build these values; do not inline the literal elsewhere. */
export const TERMINAL_TAB_PREFIX = "terminal:"

const isStaticTab = (value: string): value is RightPanelStaticTab =>
  (RIGHT_PANEL_TAB_VALUES as readonly string[]).includes(value)

const isTerminalTab = (value: string): value is RightPanelTerminalTab => {
  if (!value.startsWith(TERMINAL_TAB_PREFIX)) return false
  return value.length > TERMINAL_TAB_PREFIX.length
}

export const isRightPanelTab = (value: unknown): value is RightPanelTab => {
  if (typeof value !== "string") return false
  return isStaticTab(value) || isTerminalTab(value)
}

export const isRightPanelTerminalTab = (value: unknown): value is RightPanelTerminalTab =>
  typeof value === "string" && isTerminalTab(value)

/** Extract the terminal id portion of a `terminal:<id>` tab value. */
export const terminalTabId = (value: RightPanelTerminalTab): string => value.slice(TERMINAL_TAB_PREFIX.length)

/**
 * Build a `terminal:<id>` tab value from a raw id. The id must be non-empty:
 * an empty id yields `"terminal:"`, which `isTerminalTab` rejects and which
 * would silently break the RightPanelTerminalTab invariant downstream. All
 * current call sites already pass real terminal ids (terminal.all() tab ids,
 * with `if (!id) return` guards upstream), so this throw never fires in
 * practice — it fails fast and loud if a future caller regresses.
 */
export const terminalTabValue = (id: string): RightPanelTerminalTab => {
  if (!id) throw new Error("terminalTabValue requires a non-empty terminal id")
  return `${TERMINAL_TAB_PREFIX}${id}` as RightPanelTerminalTab
}

// Used when reading legacy persisted state where invalid input should remain unset.
export const coerceLegacySidePanelTab = (value: unknown): RightPanelTab | undefined => {
  if (value === "changes") return "review"
  if (value === "files") return "status" // files tab merged into status panel
  if (value === "terminal") return undefined // legacy fixed terminal slot is gone
  return isRightPanelTab(value) ? value : undefined
}

// Used for default tab migration where callers always need a concrete fallback.
export const migrateLegacyRightPanelTab = (tab?: string): RightPanelTab => {
  if (tab === "changes") return "review"
  if (tab === "terminal") return "status" // legacy fixed slot; flatten dropped it
  if (tab === "files") return "status" // files tab merged into status panel
  if (tab === "review" || tab === "status" || tab === "context") return tab
  if (typeof tab === "string" && isRightPanelTab(tab)) return tab
  return "status"
}

export const defaultRightPanelTab = (tab?: string) => migrateLegacyRightPanelTab(tab)

export interface ShellTabState {
  openShellTabs: RightPanelStaticTab[]
  sidePanelTab: RightPanelTab
}

export const normalizeShellTabs = (input: { openShellTabs: unknown; sidePanelTab: unknown }): ShellTabState => {
  const filtered: RightPanelStaticTab[] = []
  const seen = new Set<RightPanelStaticTab>()

  if (Array.isArray(input.openShellTabs)) {
    for (const entry of input.openShellTabs) {
      // Only static tabs persist in openShellTabs; terminal:<id> entries
      // would be ambiguous because terminal state is owned by terminal.all().
      if (typeof entry !== "string") continue
      if (!isStaticTab(entry)) continue
      if (seen.has(entry)) continue
      seen.add(entry)
      filtered.push(entry)
    }
  }

  const openShellTabs: RightPanelStaticTab[] =
    filtered[0] === "status" ? filtered : ["status", ...filtered.filter((tab) => tab !== "status")]

  const requested = isRightPanelTab(input.sidePanelTab) ? input.sidePanelTab : "status"
  // Terminal tabs are NOT in openShellTabs — they're validated separately at the
  // call site against terminal.all(). Static tabs must be in openShellTabs.
  let sidePanelTab: RightPanelTab
  if (isTerminalTab(requested)) {
    sidePanelTab = requested
  } else if ((openShellTabs as readonly string[]).includes(requested)) {
    sidePanelTab = requested
  } else {
    sidePanelTab = "status"
  }

  return { openShellTabs, sidePanelTab }
}

export const openShellTab = (state: ShellTabState, target: RightPanelTab): ShellTabState => {
  // Terminal tabs don't enter openShellTabs storage; just update the active selector.
  if (isTerminalTab(target)) {
    return { openShellTabs: state.openShellTabs, sidePanelTab: target }
  }
  const openShellTabs = state.openShellTabs.includes(target) ? state.openShellTabs : [...state.openShellTabs, target]
  return normalizeShellTabs({ openShellTabs, sidePanelTab: target })
}

export const closeShellTab = (state: ShellTabState, target: RightPanelTab): ShellTabState => {
  if (target === "status") return state

  // Closing a terminal tab is owned by terminal.close; here we just shift focus
  // off it if it was active. openShellTabs is unaffected.
  if (isTerminalTab(target)) {
    if (state.sidePanelTab !== target) return state
    return { openShellTabs: state.openShellTabs, sidePanelTab: "status" }
  }

  const index = state.openShellTabs.indexOf(target)
  if (index === -1) return state

  const nextActive: RightPanelTab =
    state.sidePanelTab === target
      ? (state.openShellTabs[index - 1] ?? state.openShellTabs[index + 1] ?? "status")
      : state.sidePanelTab

  return normalizeShellTabs({
    openShellTabs: state.openShellTabs.filter((tab) => tab !== target),
    sidePanelTab: nextActive,
  })
}

export const toggleShellTab = (
  state: ShellTabState,
  target: RightPanelTab,
  panelOpen: boolean,
): { state: ShellTabState; closePanel: boolean } => {
  if (target === "status") return { state: openShellTab(state, target), closePanel: false }
  if (state.sidePanelTab === target && panelOpen) return { state, closePanel: true }
  return { state: openShellTab(state, target), closePanel: false }
}

/**
 * Decide whether the deferred selection write scheduled by openTab (see
 * layout.tsx for the Kobalte race it works around) should still commit when
 * the microtask runs.
 *
 * Skip when:
 *   - the target chip was closed between sync commit and microtask, or
 *   - someone else moved sidePanelTab off `baseline` in the meantime (e.g.
 *     a same-tick openTab(B) ran synchronously and we'd otherwise overwrite
 *     B with our deferred A).
 *
 * Pure on purpose so the Kobalte workaround stays unit-testable without
 * standing up the full layout context.
 */
export const shouldCommitDeferredOpen = (
  after: ShellTabState,
  target: RightPanelTab,
  baseline: RightPanelTab,
): boolean => {
  if (isTerminalTab(target)) return false
  if (!(after.openShellTabs as readonly string[]).includes(target)) return false
  if (after.sidePanelTab !== baseline) return false
  return true
}

/**
 * Decide whether an active `terminal:<id>` selection is dangling — i.e. points
 * at a terminal that no longer exists — so the caller can fall back to status.
 *
 * Crucially this returns false while the terminal store is still hydrating
 * (`ready === false`): terminal.all() is empty until persistence loads, and
 * layout's persisted `sidePanelTab` can restore a `terminal:<id>` before the
 * terminal store catches up. Judging staleness too early would bounce a user
 * who was parked on a terminal back to Status on reopen. Once ready() flips
 * true the caller's effect re-runs and re-validates against the real list.
 *
 * Pure on purpose so the restore-race guard stays unit-testable without
 * standing up the full SessionSidePanel context.
 */
export const isDanglingTerminalSelection = (
  tab: RightPanelTab,
  ready: boolean,
  terminalIds: readonly string[],
): boolean => {
  if (!isTerminalTab(tab)) return false
  if (!ready) return false
  return !terminalIds.includes(terminalTabId(tab))
}

export const moveShellTab = (state: ShellTabState, target: RightPanelTab, to: number): ShellTabState => {
  if (target === "status") return state
  // Terminal tab reorder is owned by terminal.move; this helper only reorders
  // static tabs in openShellTabs.
  if (isTerminalTab(target)) return state

  const from = state.openShellTabs.indexOf(target)
  if (from === -1) return state

  // Minimum index 1 keeps tabs after pinned status; maximum is the last open tab position.
  const clampedTo = Math.min(Math.max(to, 1), state.openShellTabs.length - 1)
  const next = [...state.openShellTabs]
  next.splice(clampedTo, 0, next.splice(from, 1)[0])
  return normalizeShellTabs({ openShellTabs: next, sidePanelTab: state.sidePanelTab })
}
