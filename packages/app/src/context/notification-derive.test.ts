import { describe, expect, test } from "bun:test"
import { questionCallKey, questionNotificationAction, resolveRootSessionIDAsync, unreadSessionCount } from "./notification-derive"

describe("unreadSessionCount", () => {
  test("counts distinct unseen sessions, not the total notification count", () => {
    const notifications = [
      { session: "ses_a", viewed: false, time: 10 },
      { session: "ses_a", viewed: false, time: 11 },
      { session: "ses_b", viewed: false, time: 12 },
    ]
    expect(unreadSessionCount(notifications)).toBe(2)
  })

  test("excludes sessions whose notifications have all been viewed", () => {
    const notifications = [
      { session: "ses_a", viewed: false, time: 10 },
      { session: "ses_b", viewed: true, time: 11 },
    ]
    expect(unreadSessionCount(notifications)).toBe(1)
  })

  test("ignores notifications with no session", () => {
    expect(unreadSessionCount([{ viewed: false, time: 10 }])).toBe(0)
  })

  test("is zero when nothing is unseen", () => {
    expect(unreadSessionCount([])).toBe(0)
  })

  test("ignores notifications created before the since cutoff", () => {
    const notifications = [
      { session: "ses_old", viewed: false, time: 5 },
      { session: "ses_new", viewed: false, time: 20 },
    ]
    // Persisted backlog from a previous run (older timestamps) must not surface
    // on the Dock badge at launch; only this run's notifications count.
    expect(unreadSessionCount(notifications, 10)).toBe(1)
  })

  test("counts notifications at exactly the since cutoff", () => {
    const notifications = [{ session: "ses_a", viewed: false, time: 10 }]
    expect(unreadSessionCount(notifications, 10)).toBe(1)
  })
})

describe("resolveRootSessionIDAsync", () => {
  // getParentID is injected so the same walk works whether the parent comes
  // from the in-memory session list or an async network lookup (the latter is
  // what kicks in when a background project's sessions were never bootstrapped).
  const parentLookup = (chain: Record<string, string | undefined>) => async (id: string) => chain[id]

  test("walks the parent chain to the root session", async () => {
    const getParentID = parentLookup({ ses_leaf: "ses_child", ses_child: "ses_root", ses_root: undefined })
    expect(await resolveRootSessionIDAsync("ses_leaf", getParentID)).toBe("ses_root")
  })

  test("returns the session itself when it has no parent", async () => {
    expect(await resolveRootSessionIDAsync("ses_root", async () => undefined)).toBe("ses_root")
  })

  test("returns the id unchanged when the parent lookup yields nothing", async () => {
    expect(await resolveRootSessionIDAsync("ses_missing", async () => undefined)).toBe("ses_missing")
  })

  test("breaks parent cycles instead of looping forever", async () => {
    const getParentID = parentLookup({ ses_a: "ses_b", ses_b: "ses_a" })
    expect(await resolveRootSessionIDAsync("ses_a", getParentID)).toBe("ses_a")
  })
})

describe("questionCallKey", () => {
  test("builds a stable dedupe key from directory, session, and part", () => {
    expect(questionCallKey("/repo", "ses_1", "prt_1")).toBe("/repo:ses_1:prt_1")
  })
})

describe("questionNotificationAction", () => {
  test("notifies only once the external question input is ready", () => {
    expect(
      questionNotificationAction({
        type: "tool",
        tool: "question",
        state: { status: "running", metadata: { externalResultReady: true } },
      }),
    ).toBe("notify")
  })

  test("ignores a running question that is not yet ready", () => {
    expect(
      questionNotificationAction({
        type: "tool",
        tool: "question",
        state: { status: "running", metadata: { externalResultReady: false } },
      }),
    ).toBe("ignore")
  })

  test("resets the dedupe entry when the question part is no longer running", () => {
    expect(
      questionNotificationAction({
        type: "tool",
        tool: "question",
        state: { status: "completed", metadata: { externalResultReady: true } },
      }),
    ).toBe("reset")
  })

  test("ignores parts that are not the question tool", () => {
    expect(questionNotificationAction({ type: "text" })).toBe("ignore")
  })
})
