import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  PAWWORK_SESSION_WINDOW_INITIAL,
  PAWWORK_SESSION_WINDOW_MAX,
  PAWWORK_SESSION_WINDOW_STEP,
  buildPawworkSessionWindow,
  nextPawworkSessionWindowLimit,
} from "./pawwork-session-window"

const session = (id: string, created: number, directory = "/repo") =>
  ({
    id,
    directory,
    title: id,
    time: { created, updated: created },
  }) as Session

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

describe("buildPawworkSessionWindow", () => {
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
