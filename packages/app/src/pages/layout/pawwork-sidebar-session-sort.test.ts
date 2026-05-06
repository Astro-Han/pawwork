import { describe, expect, test } from "bun:test"
import { pawworkSidebarSessionTime, sortPawworkSidebarSessions } from "./pawwork-session-source"

describe("sortPawworkSidebarSessions", () => {
  test("sorts sessions globally by creation time before project label", () => {
    const result = sortPawworkSidebarSessions([
      { id: "older-a", created: 100, projectLabel: "alpha" },
      { id: "newer-b", created: 300, projectLabel: "beta" },
      { id: "middle-a", created: 200, projectLabel: "alpha" },
    ])

    expect(result.map((item) => item.id)).toEqual(["newer-b", "middle-a", "older-a"])
  })

  test("uses project label then id ascending when creation times match", () => {
    const result = sortPawworkSidebarSessions([
      { id: "zeta", created: 100, projectLabel: "beta" },
      { id: "zebra", created: 100, projectLabel: "alpha" },
      { id: "alpha", created: 100, projectLabel: "alpha" },
    ])

    expect(result.map((item) => item.id)).toEqual(["alpha", "zebra", "zeta"])
  })

  test("sorts by the latest loaded user message time", () => {
    const result = sortPawworkSidebarSessions([
      {
        id: "older-session-with-new-user-message",
        created: pawworkSidebarSessionTime(
          { time: { created: 100, updated: 400 } },
          [
            { id: "msg_1", role: "user", time: { created: 300 } },
            { id: "msg_2", role: "assistant", time: { created: 500 } },
          ],
        ),
        projectLabel: "pawwork",
      },
      {
        id: "newer-session-with-older-user-message",
        created: pawworkSidebarSessionTime(
          { time: { created: 200, updated: 600 } },
          [
            { id: "msg_3", role: "user", time: { created: 250 } },
            { id: "msg_4", role: "assistant", time: { created: 700 } },
          ],
        ),
        projectLabel: "opencli",
      },
    ])

    expect(result.map((item) => item.id)).toEqual([
      "older-session-with-new-user-message",
      "newer-session-with-older-user-message",
    ])
  })

  test("falls back to creation time instead of update time when user messages are not loaded", () => {
    const result = sortPawworkSidebarSessions([
      {
        id: "old-recently-updated",
        created: pawworkSidebarSessionTime(
          { time: { created: 1777610000000, updated: 1777689073008 } },
          undefined,
        ),
        projectLabel: "pawwork",
      },
      {
        id: "newer-session",
        created: pawworkSidebarSessionTime(
          { time: { created: 1777680000000, updated: 1777681000000 } },
          undefined,
        ),
        projectLabel: "opencli",
      },
    ])

    expect(result.map((item) => item.id)).toEqual(["newer-session", "old-recently-updated"])
  })

  test("does not promote sessions from assistant-only message caches", () => {
    const result = sortPawworkSidebarSessions([
      {
        id: "old-with-new-assistant",
        created: pawworkSidebarSessionTime(
          { time: { created: 100, updated: 900 } },
          [{ id: "msg_1", role: "assistant", time: { created: 800 } }],
        ),
        projectLabel: "pawwork",
      },
      {
        id: "newer-session",
        created: pawworkSidebarSessionTime({ time: { created: 200, updated: 300 } }, undefined),
        projectLabel: "opencli",
      },
    ])

    expect(result.map((item) => item.id)).toEqual(["newer-session", "old-with-new-assistant"])
  })
})
