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
  const normal = sortPawworkSessionWindowSessions(input.normal)
    .filter((item) => !reservedIDs.has(item.id))
    .slice(0, limit)
  const normalIDs = normal.map((item) => item.id)
  const sessions = mergeSessionsByID(normal, input.pinned, input.active ? [input.active] : [])
  const capReached = limit >= PAWWORK_SESSION_WINDOW_MAX && input.hasMore

  return {
    sessions,
    normalIDs,
    limit,
    canShowMore: input.hasMore && !capReached,
    capReached,
  }
}
