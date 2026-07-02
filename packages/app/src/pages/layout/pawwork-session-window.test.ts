import { describe, expect, test } from "bun:test"
import {
  PAWWORK_SESSION_WINDOW_INITIAL,
  PAWWORK_SESSION_WINDOW_MAX,
  PAWWORK_SESSION_WINDOW_STEP,
  type PawworkWindowSession,
  buildPawworkSessionWindow,
  nextPawworkSessionWindowLimit,
  pawworkSessionWindowActiveRoot,
  shouldAutoExpandPawworkSessionWindow,
  sortPawworkSessionWindowSessions,
} from "./pawwork-session-window"

const session = (
  id: string,
  created: number,
  options: { directory?: string; parentID?: string; activityAt?: number } = {},
) =>
  ({
    id,
    directory: options.directory ?? "/repo",
    parentID: options.parentID,
    title: id,
    time: { created, updated: created },
    activityAt: options.activityAt,
  }) as PawworkWindowSession

describe("nextPawworkSessionWindowLimit", () => {
  test("moves 30 to 60 to 90 and caps there", () => {
    expect(nextPawworkSessionWindowLimit(30)).toBe(60)
    expect(nextPawworkSessionWindowLimit(60)).toBe(90)
    expect(nextPawworkSessionWindowLimit(90)).toBe(90)
    expect(PAWWORK_SESSION_WINDOW_INITIAL).toBe(30)
    expect(PAWWORK_SESSION_WINDOW_STEP).toBe(30)
    expect(PAWWORK_SESSION_WINDOW_MAX).toBe(90)
  })
})

describe("shouldAutoExpandPawworkSessionWindow", () => {
  const base = {
    openProjectCount: 1,
    visibleCount: 0,
    loading: false,
    hasMore: true,
    limit: PAWWORK_SESSION_WINDOW_INITIAL,
    loadedLimit: PAWWORK_SESSION_WINDOW_INITIAL,
  }

  test("expands when an open project's list is empty but the window has more settled pages", () => {
    expect(shouldAutoExpandPawworkSessionWindow(base)).toBe(true)
  })

  test("does not expand with zero open projects (empty state is deliberate)", () => {
    expect(shouldAutoExpandPawworkSessionWindow({ ...base, openProjectCount: 0 })).toBe(false)
  })

  test("does not expand once any row is visible", () => {
    expect(shouldAutoExpandPawworkSessionWindow({ ...base, visibleCount: 1 })).toBe(false)
  })

  test("does not expand mid-load", () => {
    expect(shouldAutoExpandPawworkSessionWindow({ ...base, loading: true })).toBe(false)
  })

  test("does not expand when there are no more pages", () => {
    expect(shouldAutoExpandPawworkSessionWindow({ ...base, hasMore: false })).toBe(false)
  })

  test("does not expand past the cap", () => {
    expect(shouldAutoExpandPawworkSessionWindow({ ...base, limit: PAWWORK_SESSION_WINDOW_MAX })).toBe(false)
  })

  test("does not expand until the current limit's request has settled", () => {
    // showMore bumped limit to 60 but the 60-page load has not landed yet.
    expect(shouldAutoExpandPawworkSessionWindow({ ...base, limit: 60, loadedLimit: 30 })).toBe(false)
  })
})

describe("buildPawworkSessionWindow", () => {
  test("sorts the normal window by activity time before applying the limit", () => {
    const result = buildPawworkSessionWindow({
      normal: [
        session("old-active", 1, { activityAt: 5 }),
        session("new-inactive", 3, { activityAt: 3 }),
        session("middle", 2, { activityAt: 4 }),
      ],
      pinned: [],
      active: undefined,
      limit: 30,
      hasMore: false,
    })

    expect(result.normalIDs).toEqual(["old-active", "middle", "new-inactive"])
  })

  test("keeps the normal window capped while preserving pinned and active sessions", () => {
    const normal = Array.from({ length: 35 }, (_, index) => session(`ses_${index}`, 10_000 - index))
    const pinned = session("pinned_old", 1)
    const active = session("active_old", 2)

    const result = buildPawworkSessionWindow({
      normal,
      pinned: [pinned],
      active,
      limit: 30,
      hasMore: true,
    })

    expect(result.sessions.map((item) => item.id)).toContain("pinned_old")
    expect(result.sessions.map((item) => item.id)).toContain("active_old")
    expect(result.normalIDs).toHaveLength(30)
    expect(result.canShowMore).toBe(true)
    expect(result.capReached).toBe(false)
  })

  test("does not count pinned or active sessions against the normal window", () => {
    const normal = Array.from({ length: 32 }, (_, index) => session(`ses_${index}`, 10_000 - index))
    const pinned = normal[0]!
    const active = normal[1]!

    const result = buildPawworkSessionWindow({
      normal,
      pinned: [pinned],
      active,
      limit: 30,
      hasMore: true,
    })

    expect(result.normalIDs).toHaveLength(30)
    expect(result.normalIDs).not.toContain(pinned.id)
    expect(result.normalIDs).not.toContain(active.id)
    expect(result.sessions.map((item) => item.id)).toEqual([
      ...result.normalIDs,
      active.id,
      pinned.id,
    ].sort())
  })

  test("does not include an active child session as a top-level sidebar row", () => {
    const root = session("root", 100)
    const child = session("child", 200, { parentID: root.id })

    const result = buildPawworkSessionWindow({
      normal: [root],
      pinned: [],
      active: child,
      limit: 30,
      hasMore: false,
    })

    expect(result.sessions.map((item) => item.id)).toEqual(["root"])
  })

  test("does not include a pinned child session as a top-level sidebar row", () => {
    const root = session("root", 100)
    const pinnedChild = session("pinned_child", 200, { parentID: root.id })

    const result = buildPawworkSessionWindow({
      normal: [root],
      pinned: [pinnedChild],
      active: undefined,
      limit: 30,
      hasMore: false,
    })

    expect(result.sessions.map((item) => item.id)).toEqual(["root"])
  })

  test("does not include a normal child session as a top-level sidebar row", () => {
    const root = session("root", 100)
    const child = session("normal_child", 200, { parentID: root.id })

    const result = buildPawworkSessionWindow({
      normal: [root, child],
      pinned: [],
      active: undefined,
      limit: 30,
      hasMore: false,
    })

    expect(result.normalIDs).toEqual(["root"])
    expect(result.sessions.map((item) => item.id)).toEqual(["root"])
  })

  test("keeps the active child parent root visible when it is outside the normal window", () => {
    const root = session("old_root", 1)
    const child = session("child", 200, { parentID: root.id })
    const activeRoot = pawworkSessionWindowActiveRoot(child, root)

    const result = buildPawworkSessionWindow({
      normal: [],
      pinned: [],
      active: activeRoot,
      limit: 30,
      hasMore: true,
    })

    expect(result.normalIDs).toEqual([])
    expect(result.sessions.map((item) => item.id)).toEqual(["old_root"])
  })

  test("shows search prompt instead of show more at the cap", () => {
    const normal = Array.from({ length: 90 }, (_, index) => session(`ses_${index}`, 10_000 - index))

    const result = buildPawworkSessionWindow({
      normal,
      pinned: [],
      active: undefined,
      limit: 90,
      hasMore: true,
    })

    expect(result.canShowMore).toBe(false)
    expect(result.capReached).toBe(true)
  })
})

describe("pawworkSessionWindowActiveRoot", () => {
  test("uses the child parent as the sidebar root fallback", () => {
    const root = session("root", 100)
    const child = session("child", 200, { parentID: root.id })

    expect(pawworkSessionWindowActiveRoot(child, root)?.id).toBe("root")
  })

  test("does not use a mismatched parent as the sidebar root fallback", () => {
    const other = session("other", 100)
    const child = session("child", 200, { parentID: "root" })

    expect(pawworkSessionWindowActiveRoot(child, other)).toBeUndefined()
  })
})

describe("sortPawworkSessionWindowSessions", () => {
  test("uses activity time before creation time", () => {
    expect(
      sortPawworkSessionWindowSessions([
        session("newer-created", 3, { activityAt: 3 }),
        session("older-with-user-activity", 1, { activityAt: 5 }),
      ]).map((item) => item.id),
    ).toEqual(["older-with-user-activity", "newer-created"])
  })

  test("uses id as the creation-time tiebreaker", () => {
    expect(sortPawworkSessionWindowSessions([session("z", 1), session("a", 1)]).map((item) => item.id)).toEqual([
      "a",
      "z",
    ])
  })
})
