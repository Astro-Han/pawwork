import type { GlobalSession, Session } from "@opencode-ai/sdk/v2/client"

export type PawworkWindowSession = Session & Pick<GlobalSession, "activityAt" | "lastUserMessageAt">

export const PAWWORK_SESSION_WINDOW_INITIAL = 30
export const PAWWORK_SESSION_WINDOW_STEP = 30
export const PAWWORK_SESSION_WINDOW_MAX = 90

const byID = (a: PawworkWindowSession, b: PawworkWindowSession) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const sessionActivityTime = (session: PawworkWindowSession) => session.activityAt ?? session.time.created
const byActivityDesc = (a: PawworkWindowSession, b: PawworkWindowSession) => {
  const activity = sessionActivityTime(b) - sessionActivityTime(a)
  if (activity !== 0) return activity
  return byID(a, b)
}

export function nextPawworkSessionWindowLimit(current: number) {
  return Math.min(
    PAWWORK_SESSION_WINDOW_MAX,
    Math.max(PAWWORK_SESSION_WINDOW_INITIAL, current) + PAWWORK_SESSION_WINDOW_STEP,
  )
}

/**
 * The session window is fetched globally (activity-sorted, paginated) and then
 * filtered to open projects client-side, so a page of closed-project sessions
 * can filter to nothing while the window still has more pages. This decides when
 * to auto-advance the window one page so an open project's older sessions surface
 * instead of leaving the sidebar blank.
 *
 * Guards: only with open projects (the zero-project empty state is deliberate),
 * only when nothing is visible, only when more pages exist below the cap, and
 * only once the current limit's request has settled (`loadedLimit === limit`) —
 * so it steps one page at a time and never fires mid-load or retries a failed load.
 */
export function shouldAutoExpandPawworkSessionWindow(input: {
  openProjectCount: number
  visibleCount: number
  loading: boolean
  hasMore: boolean
  limit: number
  loadedLimit: number
}) {
  if (input.openProjectCount === 0) return false
  if (input.visibleCount > 0) return false
  if (input.loading) return false
  if (!input.hasMore) return false
  if (input.limit >= PAWWORK_SESSION_WINDOW_MAX) return false
  return input.loadedLimit === input.limit
}

export function mergeSessionsByID(...lists: Array<PawworkWindowSession[] | undefined>) {
  const map = new Map<string, PawworkWindowSession>()
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!item?.id || item.time?.archived) continue
      map.set(item.id, item)
    }
  }
  return [...map.values()].sort(byID)
}

export function sortPawworkSessionWindowSessions(sessions: PawworkWindowSession[]) {
  return sessions.filter((item) => !!item?.id && !item.time?.archived).slice().sort(byActivityDesc)
}

const rootSessions = (sessions: PawworkWindowSession[]) => sessions.filter((item) => !!item?.id && !item.parentID)

export function pawworkSessionWindowActiveRoot(active?: PawworkWindowSession, parent?: PawworkWindowSession) {
  if (!active?.id || active.time?.archived) return
  if (!active.parentID) return active
  if (parent?.id !== active.parentID || parent.time?.archived) return
  return parent
}

export function buildPawworkSessionWindow(input: {
  normal: PawworkWindowSession[]
  pinned: PawworkWindowSession[]
  active?: PawworkWindowSession
  limit: number
  hasMore: boolean
}) {
  const limit = Math.min(PAWWORK_SESSION_WINDOW_MAX, Math.max(PAWWORK_SESSION_WINDOW_INITIAL, input.limit))
  const reservedIDs = new Set([
    ...input.pinned.map((item) => item.id),
    ...(input.active?.id ? [input.active.id] : []),
  ])
  const normal = sortPawworkSessionWindowSessions(rootSessions(input.normal))
    .filter((item) => !reservedIDs.has(item.id))
    .slice(0, limit)
  const normalIDs = normal.map((item) => item.id)
  const sessions = mergeSessionsByID(
    normal,
    rootSessions(input.pinned),
    input.active && !input.active.parentID ? [input.active] : [],
  )
  const capReached = limit >= PAWWORK_SESSION_WINDOW_MAX && input.hasMore

  return {
    sessions,
    normalIDs,
    limit,
    canShowMore: input.hasMore && !capReached,
    capReached,
  }
}
