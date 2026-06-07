import { describe, expect, test } from "bun:test"
import { badgeSessionCount, buildNotificationIndex, isLiveNotification } from "./notification-derive"
import type { Notification } from "./notification"

describe("isLiveNotification", () => {
  test("keeps turn-complete and error, drops legacy question", () => {
    expect(isLiveNotification({ type: "turn-complete" })).toBe(true)
    expect(isLiveNotification({ type: "error" })).toBe(true)
    expect(isLiveNotification({ type: "question" })).toBe(false)
  })
})

describe("buildNotificationIndex", () => {
  test("drops legacy persisted question entries so they never strand an unread dot", () => {
    // Simulates a notification.v1 store written by an older build: an
    // already-answered question persisted as type:"question", viewed:false.
    const list = [
      { type: "question", session: "ses_q", directory: "/repo", viewed: false, time: 10 },
      { type: "turn-complete", session: "ses_done", directory: "/repo", viewed: false, time: 20 },
    ] as unknown as Notification[]

    const index = buildNotificationIndex(list)

    // The legacy question contributes nothing to session or project unread.
    expect(index.session.unseenCount["ses_q"]).toBeUndefined()
    expect(index.session.all["ses_q"]).toBeUndefined()
    expect(index.project.unseen["/repo"]?.some((n) => n.type !== "turn-complete" && n.type !== "error")).toBeFalsy()
    // The live turn-complete still counts.
    expect(index.session.unseenCount["ses_done"]).toBe(1)
    expect(index.project.unseenCount["/repo"]).toBe(1)
  })

  test("counts unseen turn-complete and error, flags error, skips viewed", () => {
    const list = [
      { type: "turn-complete", session: "ses_a", directory: "/r", viewed: false, time: 1 },
      { type: "error", session: "ses_a", directory: "/r", viewed: false, time: 2 },
      { type: "turn-complete", session: "ses_b", directory: "/r", viewed: true, time: 3 },
    ] as unknown as Notification[]

    const index = buildNotificationIndex(list)

    expect(index.session.unseenCount["ses_a"]).toBe(2)
    expect(index.session.unseenHasError["ses_a"]).toBe(true)
    expect(index.session.unseenCount["ses_b"]).toBeUndefined()
    expect(index.project.unseenCount["/r"]).toBe(2)
  })
})

describe("badgeSessionCount", () => {
  test("counts distinct unseen sessions, not the total notification count", () => {
    const notifications = [
      { session: "ses_a", viewed: false, time: 10 },
      { session: "ses_a", viewed: false, time: 11 },
      { session: "ses_b", viewed: false, time: 12 },
    ]
    expect(badgeSessionCount(notifications, [])).toBe(2)
  })

  test("excludes sessions whose notifications have all been viewed", () => {
    const notifications = [
      { session: "ses_a", viewed: false, time: 10 },
      { session: "ses_b", viewed: true, time: 11 },
    ]
    expect(badgeSessionCount(notifications, [])).toBe(1)
  })

  test("ignores notifications with no session", () => {
    expect(badgeSessionCount([{ viewed: false, time: 10 }], [])).toBe(0)
  })

  test("is zero when nothing is unseen and nothing is pending", () => {
    expect(badgeSessionCount([], [])).toBe(0)
  })

  test("ignores notifications created before the since cutoff", () => {
    const notifications = [
      { session: "ses_old", viewed: false, time: 5 },
      { session: "ses_new", viewed: false, time: 20 },
    ]
    // Persisted backlog from a previous run (older timestamps) must not surface
    // on the Dock badge at launch; only this run's notifications count.
    expect(badgeSessionCount(notifications, [], 10)).toBe(1)
  })

  test("counts notifications at exactly the since cutoff", () => {
    const notifications = [{ session: "ses_a", viewed: false, time: 10 }]
    expect(badgeSessionCount(notifications, [], 10)).toBe(1)
  })

  test("adds pending question roots, which are never since-scoped", () => {
    // ses_pending arrived before the cutoff but is a live condition → still badges.
    const notifications = [{ session: "ses_event", viewed: false, time: 20 }]
    expect(badgeSessionCount(notifications, ["ses_pending"], 10)).toBe(2)
  })

  test("unions a session that is both unseen and pending into one unit", () => {
    const notifications = [{ session: "ses_a", viewed: false, time: 20 }]
    expect(badgeSessionCount(notifications, ["ses_a"], 10)).toBe(1)
  })

  test("counts a pending root even with no notifications at all", () => {
    expect(badgeSessionCount([], ["ses_a", "ses_b"])).toBe(2)
  })
})
