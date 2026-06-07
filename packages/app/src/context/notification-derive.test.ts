import { describe, expect, test } from "bun:test"
import { badgeSessionCount } from "./notification-derive"

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
