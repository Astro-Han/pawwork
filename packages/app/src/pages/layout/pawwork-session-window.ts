import type { Session } from "@opencode-ai/sdk/v2/client"

export const PAWWORK_SESSION_WINDOW_INITIAL = 30
export const PAWWORK_SESSION_WINDOW_STEP = 30
export const PAWWORK_SESSION_WINDOW_MAX = 90

const byID = (a: Session, b: Session) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const byCreatedDesc = (a: Session, b: Session) => {
  const created = b.time.created - a.time.created
  if (created !== 0) return created
  return byID(a, b)
}

export function nextPawworkSessionWindowLimit(current: number) {
  return Math.min(
    PAWWORK_SESSION_WINDOW_MAX,
    Math.max(PAWWORK_SESSION_WINDOW_INITIAL, current) + PAWWORK_SESSION_WINDOW_STEP,
  )
}

export function mergeSessionsByID(...lists: Array<Session[] | undefined>) {
  const map = new Map<string, Session>()
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!item?.id || item.time?.archived) continue
      map.set(item.id, item)
    }
  }
  return [...map.values()].sort(byID)
}

export function sortPawworkSessionWindowSessions(sessions: Session[]) {
  return sessions.filter((item) => !!item?.id && !item.time?.archived).slice().sort(byCreatedDesc)
}

export function buildPawworkSessionWindow(input: {
  normal: Session[]
  pinned: Session[]
  active?: Session
  limit: number
  hasMore: boolean
}) {
  const limit = Math.min(PAWWORK_SESSION_WINDOW_MAX, Math.max(PAWWORK_SESSION_WINDOW_INITIAL, input.limit))
  const normal = sortPawworkSessionWindowSessions(input.normal).slice(0, limit)
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
