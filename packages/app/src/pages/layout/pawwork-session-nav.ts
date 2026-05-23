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
 * currently loaded into the sidebar window) at their original raw positions.
 *
 * Conceptually: visible slots inside `pinnedIDs` get refilled by the new
 * visible order; hidden slots are anchored. This keeps drag indexes,
 * menu-driven moves, and rendered row order coupled to the same surface
 * (the rendered list), without losing data about un-loaded pinned sessions.
 */
export function reorderPawworkPinnedByVisible(input: {
  pinnedIDs: string[]
  /** Currently rendered pinned session IDs, in rendered order. */
  visiblePinnedIDs: string[]
  sourceID: string
  /** Slot in the new visible order (0 = top of pinned section). */
  targetVisibleIndex: number
}): string[] {
  const nextVisible = input.visiblePinnedIDs.filter((id) => id !== input.sourceID)
  const clampedIndex = Math.max(0, Math.min(nextVisible.length, input.targetVisibleIndex))
  nextVisible.splice(clampedIndex, 0, input.sourceID)

  const visibleSet = new Set<string>(input.visiblePinnedIDs)
  visibleSet.add(input.sourceID)

  const result: string[] = []
  let visibleCursor = 0
  for (const id of input.pinnedIDs) {
    if (id === input.sourceID) continue
    if (visibleSet.has(id)) {
      result.push(nextVisible[visibleCursor]!)
      visibleCursor++
    } else {
      result.push(id)
    }
  }
  // Source was not previously in pinnedIDs (cross-zone drop from recent /
  // project group): append the remaining visible tail.
  while (visibleCursor < nextVisible.length) {
    result.push(nextVisible[visibleCursor]!)
    visibleCursor++
  }
  return result
}

/** Drop `sourceID` from the pinned array (unpin). Hidden pinned IDs untouched. */
export function unpinPawworkSession(input: { pinnedIDs: string[]; sourceID: string }): string[] {
  return input.pinnedIDs.filter((id) => id !== input.sourceID)
}
