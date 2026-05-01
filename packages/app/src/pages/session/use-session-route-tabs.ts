import { createEffect, createMemo, on } from "solid-js"
import type { useLayout } from "@/context/layout"
import { createSessionTabs } from "@/pages/session/helpers"
import type { useSessionLayout } from "@/pages/session/session-layout"

export function createSessionRouteTabs(input: {
  directory: () => string
  sessionID: () => string | undefined
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<typeof useSessionLayout>["tabs"]
  pathFromTab: (tab: string) => string | undefined
  tabForPath: (path: string) => string
  review: () => boolean
  hasReview: () => boolean
}) {
  const workspaceKey = createMemo(() => input.directory())
  const workspaceTabs = createMemo(() => input.layout.tabs(workspaceKey()))

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return input.tabForPath(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  createEffect(
    on(
      input.sessionID,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = input.layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          input.layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        input.layout.handoff.clearTabs()
        if (pending.dir !== input.directory()) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = input.tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        input.tabs().setAll(all)
        input.tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  return createSessionTabs({
    tabs: input.tabs,
    pathFromTab: input.pathFromTab,
    normalizeTab,
    review: input.review,
    hasReview: input.hasReview,
  })
}
