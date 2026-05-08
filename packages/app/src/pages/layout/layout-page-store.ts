import { Persist } from "@/utils/persist"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMaybeJSON(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function pinnedSessions(value: unknown) {
  if (!Array.isArray(value)) return [] as string[]
  const seen = new Set<string>()
  return value.filter((item): item is string => {
    if (typeof item !== "string") return false
    if (!item) return false
    if (seen.has(item)) return false
    seen.add(item)
    return true
  })
}

function projectCollapsed(value: unknown) {
  if (!record(value)) return {} as Record<string, boolean>
  const out: Record<string, boolean> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof key === "string" && key && val === true) out[key] = true
  }
  return out
}

function hasLayoutPageFields(value: Record<string, unknown>) {
  return (
    "pawworkPinnedSessions" in value ||
    "pawworkSortMode" in value ||
    "pawworkProjectCollapsed" in value
  )
}

export function createDefaultLayoutPageState() {
  return {
    activeProject: undefined as string | undefined,
    activeWorkspace: undefined as string | undefined,
    workspaceOrder: {} as Record<string, string[]>,
    workspaceName: {} as Record<string, string>,
    workspaceBranchName: {} as Record<string, Record<string, string>>,
    workspaceExpanded: {} as Record<string, boolean>,
    gettingStartedDismissed: false,
    pawworkPinnedSessions: [] as string[],
    pawworkSortMode: "time" as "time" | "project",
    pawworkProjectCollapsed: {} as Record<string, boolean>,
  }
}

export function migrateLayoutPageState(value: unknown) {
  const decoded = parseMaybeJSON(value)
  if (!record(decoded)) return undefined

  if ("page" in decoded) {
    const parsedPage = parseMaybeJSON(decoded.page)
    if (!record(parsedPage)) {
      if (!hasLayoutPageFields(decoded)) return undefined
      return {
        ...decoded,
        pawworkPinnedSessions: pinnedSessions(decoded.pawworkPinnedSessions),
        pawworkSortMode: decoded.pawworkSortMode === "project" ? "project" : "time",
        pawworkProjectCollapsed: projectCollapsed(decoded.pawworkProjectCollapsed),
      }
    }
    if (!hasLayoutPageFields(parsedPage)) return undefined
    return {
      ...parsedPage,
      pawworkPinnedSessions: pinnedSessions(parsedPage.pawworkPinnedSessions),
      pawworkSortMode: parsedPage.pawworkSortMode === "project" ? "project" : "time",
      pawworkProjectCollapsed: projectCollapsed(parsedPage.pawworkProjectCollapsed),
    }
  }

  if (!hasLayoutPageFields(decoded)) return undefined

  return {
    ...decoded,
    pawworkPinnedSessions: pinnedSessions(decoded.pawworkPinnedSessions),
    pawworkSortMode: decoded.pawworkSortMode === "project" ? "project" : "time",
    pawworkProjectCollapsed: projectCollapsed(decoded.pawworkProjectCollapsed),
  }
}

export function createLayoutPagePersistTarget() {
  return {
    ...Persist.global("layout-page", ["layout.page.v1"]),
    currentLegacy: ["layout.page", "layout"],
    migrate: migrateLayoutPageState,
  }
}
