import { pawworkSessionRowKey } from "./helpers"
import type { PawworkSessionSections } from "./pawwork-session-nav"
import type { PawworkSidebarSession } from "./pawwork-sidebar"

export type PawworkSidebarGroupCollection = {
  key: string
  label: string
  rowKeys: string[]
}

export function buildPawworkSidebarCollections(input: {
  sessions: PawworkSidebarSession[]
  sections: PawworkSessionSections
}) {
  const rowKeyFor = (item: { directory: string; id: string }) => pawworkSessionRowKey(item)
  const rowByKey = new Map(input.sessions.map((item) => [rowKeyFor(item.session), item] as const))
  const pinnedRowKeys = input.sections.pinned.map(rowKeyFor).filter((key) => rowByKey.has(key))
  const recentRowKeys = input.sections.recent.map(rowKeyFor).filter((key) => rowByKey.has(key))
  const groupByKey = new Map<string, PawworkSidebarGroupCollection>()
  const groupKeys: string[] = []

  for (const group of input.sections.groups) {
    const collection: PawworkSidebarGroupCollection = {
      key: group.key,
      label: group.label,
      rowKeys: group.items.map(rowKeyFor).filter((key) => rowByKey.has(key)),
    }
    groupByKey.set(collection.key, collection)
    groupKeys.push(collection.key)
  }

  return {
    rowByKey,
    pinnedRowKeys,
    recentRowKeys,
    groupKeys,
    groupByKey,
  }
}
