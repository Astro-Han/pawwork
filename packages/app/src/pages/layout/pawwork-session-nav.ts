export type PawworkSortMode = "time" | "project"

export type PawworkSessionItem = {
  id: string
  title: string
  directory: string
  projectLabel: string
  updated: number
}

export function buildPawworkSessionSections(input: {
  sessions: PawworkSessionItem[]
  pinnedIDs: string[]
  sortMode: PawworkSortMode
  currentSessionID?: string
}) {
  const pinnedSet = new Set(input.pinnedIDs)
  const pinned = input.pinnedIDs
    .map((id) => input.sessions.find((item) => item.id === id))
    .filter((item): item is PawworkSessionItem => !!item)

  const unpinned = input.sessions.filter((item) => !pinnedSet.has(item.id))

  if (input.sortMode === "time") {
    return {
      pinned,
      recent: unpinned.sort((a, b) => b.updated - a.updated),
      groups: [] as { label: string; items: PawworkSessionItem[] }[],
    }
  }

  const groups = new Map<string, PawworkSessionItem[]>()
  for (const item of unpinned.sort((a, b) => b.updated - a.updated)) {
    const key = item.projectLabel || "other"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }

  return {
    pinned,
    recent: [] as PawworkSessionItem[],
    groups: [...groups.entries()].map(([label, items]) => ({ label, items })),
  }
}

export function movePawworkSession(input: {
  pinnedIDs: string[]
  visibleUnpinnedIDs: string[]
  sourceID: string
  targetSection: "pinned" | "recent"
  targetIndex: number
}) {
  const nextPinned = input.pinnedIDs.filter((id) => id !== input.sourceID)
  if (input.targetSection === "pinned") {
    nextPinned.splice(input.targetIndex, 0, input.sourceID)
  }
  return nextPinned
}
