export type PawworkSortMode = "time" | "project"

export type PawworkSessionItem = {
  id: string
  title: string
  directory: string
  projectKey: string
  projectLabel: string
  created: number
}

function comparePawworkSessionsByCreated(a: PawworkSessionItem, b: PawworkSessionItem) {
  const created = b.created - a.created
  if (created !== 0) return created
  return a.id.localeCompare(b.id)
}

export function buildPawworkSessionSections(input: {
  sessions: PawworkSessionItem[]
  pinnedIDs: string[]
  sortMode: PawworkSortMode
}) {
  const pinnedSet = new Set(input.pinnedIDs)
  const pinned = input.pinnedIDs
    .map((id) => input.sessions.find((item) => item.id === id))
    .filter((item): item is PawworkSessionItem => !!item)

  const unpinned = input.sessions.filter((item) => !pinnedSet.has(item.id))

  if (input.sortMode === "time") {
    return {
      pinned,
      recent: unpinned.sort(comparePawworkSessionsByCreated),
      groups: [] as { key: string; label: string; items: PawworkSessionItem[] }[],
    }
  }

  const groups = new Map<string, PawworkSessionItem[]>()
  for (const item of unpinned.sort(comparePawworkSessionsByCreated)) {
    const key = item.projectKey || item.directory || "other"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  return {
    pinned,
    recent: [] as PawworkSessionItem[],
    groups: [...groups.entries()].map(([key, items]) => ({
      key,
      label: items[0]?.projectLabel || key,
      items,
    })),
  }
}

export type PawworkSessionSections = ReturnType<typeof buildPawworkSessionSections>

export type PawworkSessionNavigationEntry = {
  item: PawworkSessionItem
  groupKey?: string
  groupLabel?: string
}

export function flattenPawworkSessionSections(sections: PawworkSessionSections): PawworkSessionNavigationEntry[] {
  return [
    ...sections.pinned.map((item) => ({ item })),
    ...sections.recent.map((item) => ({ item })),
    ...sections.groups.flatMap((group) =>
      group.items.map((item) => ({ item, groupKey: group.key, groupLabel: group.label })),
    ),
  ]
}

export function findPawworkSessionNavigationTarget(input: {
  sections: PawworkSessionSections
  currentSessionID?: string
  offset: number
  include?: (item: PawworkSessionItem) => boolean
}) {
  const ordered = flattenPawworkSessionSections(input.sections)
  if (ordered.length === 0) return undefined

  if (input.include && !ordered.some((entry) => input.include?.(entry.item))) return undefined

  const currentIndex = input.currentSessionID
    ? ordered.findIndex((entry) => entry.item.id === input.currentSessionID)
    : -1
  const start = currentIndex === -1 ? (input.offset > 0 ? -1 : 0) : currentIndex

  for (let step = 1; step <= ordered.length; step++) {
    const index =
      input.offset > 0 ? (start + step) % ordered.length : (start - step + ordered.length) % ordered.length
    const candidate = ordered[index]
    if (!candidate) continue
    if (input.include && !input.include(candidate.item)) continue
    return candidate
  }

  return undefined
}

/**
 * Reorder pinned IDs by a visible-list operation, preserving any pinned IDs
 * that are NOT in `visiblePinnedIDs` (sessions persisted as pinned but not
 * currently loaded into the sidebar window) at their original raw indexes.
 *
 * Algorithm: find the raw indexes of the visible slots, then refill those
 * exact slots with the reordered visible IDs. Hidden slots are never iterated
 * over with a moving cursor, so they cannot drift earlier or later just
 * because the source crossed them. A cross-zone source (not previously
 * pinned) is then spliced in at a raw index derived from its visible
 * neighbour — between the visible-slot-before and the visible-slot-at the
 * target, so the user's visual drop position is preserved.
 */
export function reorderPawworkPinnedByVisible(input: {
  pinnedIDs: string[]
  /** Currently rendered pinned session IDs, in rendered order. */
  visiblePinnedIDs: string[]
  sourceID: string
  /** Slot in the new visible order (0 = top of pinned section). */
  targetVisibleIndex: number
}): string[] {
  const pinnedSet = new Set(input.pinnedIDs)
  // Defensive narrowing: if the caller's visible memo is stale (a session was
  // unpinned between memo recompute and this call), drop visible IDs that
  // are no longer pinned. Without this the refill loop would silently lose
  // tail entries when `visibleRawIndexes.length < visiblePinnedIDs.length`.
  const visiblePinnedIDs = input.visiblePinnedIDs.filter((id) => pinnedSet.has(id))
  const visibleSet = new Set<string>(visiblePinnedIDs)

  // Raw indexes that hold currently-visible IDs, in raw order.
  const visibleRawIndexes: number[] = []
  for (let i = 0; i < input.pinnedIDs.length; i++) {
    if (visibleSet.has(input.pinnedIDs[i]!)) visibleRawIndexes.push(i)
  }

  // "Already pinned" must check the raw array, not just the visible set —
  // otherwise a hidden-anchor source would fall through to the cross-zone
  // branch and get spliced in a second time, duplicating the ID.
  const sourceAlreadyPinned = pinnedSet.has(input.sourceID)
  const sourceIsVisible = visibleSet.has(input.sourceID)

  if (sourceAlreadyPinned) {
    if (!sourceIsVisible) {
      // Source is pinned but not rendered (hidden anchor). The UI does not
      // currently surface these rows, so this is a defensive no-op; mutating
      // would either duplicate or invent a visible position we cannot verify.
      return input.pinnedIDs
    }

    const currentVisibleIndex = visiblePinnedIDs.indexOf(input.sourceID)
    const nextVisible = visiblePinnedIDs.filter((id) => id !== input.sourceID)
    const clampedTarget = Math.max(0, Math.min(nextVisible.length, input.targetVisibleIndex))
    // Fast-path no-op: dropping onto the current slot would rebuild the array
    // for no reason. Preserve identity so setStore can short-circuit.
    if (clampedTarget === currentVisibleIndex) return input.pinnedIDs

    nextVisible.splice(clampedTarget, 0, input.sourceID)
    const result = [...input.pinnedIDs]
    for (let i = 0; i < visibleRawIndexes.length; i++) {
      result[visibleRawIndexes[i]!] = nextVisible[i]!
    }
    return result
  }

  // Cross-zone insert: source is new to the pinned array. Existing visible
  // slots keep their raw indexes; source needs a brand-new slot derived from
  // the visible neighbour at the target.
  const visibleCount = visiblePinnedIDs.length
  const clampedTarget = Math.max(0, Math.min(visibleCount, input.targetVisibleIndex))
  const result = [...input.pinnedIDs]
  let insertAt: number
  if (visibleRawIndexes.length === 0) {
    // No visible neighbours to reference — drop at the end of raw. Empty
    // pinned section may still hold hidden anchors; appending keeps those
    // anchored ahead of the new item.
    insertAt = input.pinnedIDs.length
  } else if (clampedTarget === 0) {
    insertAt = visibleRawIndexes[0]!
  } else if (clampedTarget >= visibleRawIndexes.length) {
    insertAt = visibleRawIndexes[visibleRawIndexes.length - 1]! + 1
  } else {
    // Drop between visible-slot (target-1) and visible-slot (target). Use
    // the target-slot's raw index — splice(insertAt, 0, src) shifts that
    // slot right, putting source visually before it.
    insertAt = visibleRawIndexes[clampedTarget]!
  }
  result.splice(insertAt, 0, input.sourceID)
  return result
}

/**
 * Drop `sourceID` from the pinned array (unpin). Returns the original array
 * identity when the source was not pinned, so a downstream setStore is a
 * no-op rather than scheduling a fresh array.
 */
export function unpinPawworkSession(input: { pinnedIDs: string[]; sourceID: string }): string[] {
  if (!input.pinnedIDs.includes(input.sourceID)) return input.pinnedIDs
  return input.pinnedIDs.filter((id) => id !== input.sourceID)
}
