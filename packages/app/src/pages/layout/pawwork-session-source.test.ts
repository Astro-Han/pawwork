import { describe, expect, test } from "bun:test"
import {
  buildPawworkSidebarSessionRows,
  pawworkSidebarSessionTime,
  resolvePawworkProjectLabels,
  sortPawworkSidebarSessions,
} from "./pawwork-session-source"

describe("resolvePawworkProjectLabels", () => {
  test("keeps unique project names unchanged", () => {
    const result = resolvePawworkProjectLabels(
      [
        { worktree: "/Users/yuhan/dev/pawwork", name: "PawWork" },
        { worktree: "/Users/yuhan/oss/opencli", name: "OpenCLI" },
      ],
      "/Users/yuhan",
    )

    expect(result.get("/Users/yuhan/dev/pawwork")).toBe("PawWork")
    expect(result.get("/Users/yuhan/oss/opencli")).toBe("OpenCLI")
  })

  test("falls back to a shortened worktree path when display names collide", () => {
    const result = resolvePawworkProjectLabels(
      [
        { worktree: "/Users/yuhan/dev/one/app", name: "app" },
        { worktree: "/Users/yuhan/oss/two/app", name: "app" },
      ],
      "/Users/yuhan",
    )

    expect(result.get("/Users/yuhan/dev/one/app")).toBe("~/dev/one/app")
    expect(result.get("/Users/yuhan/oss/two/app")).toBe("~/oss/two/app")
  })
})

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

describe("buildPawworkSidebarSessionRows", () => {
  test("uses loaded user message time for sidebar rows", () => {
    const result = buildPawworkSidebarSessionRows(
      [
        {
          id: "session-old",
          directory: "/repo",
          time: { created: 100, updated: 900 },
        },
      ],
      {
        slugForDirectory: (directory) => `slug:${directory}`,
        projectLabelForSession: () => "PawWork",
        messagesForSession: () => [
          { id: "msg_1", role: "assistant", time: { created: 950 } },
          { id: "msg_2", role: "user", time: { created: 800 } },
        ],
      },
    )

    expect(result).toEqual([
      {
        session: {
          id: "session-old",
          directory: "/repo",
          time: { created: 100, updated: 900 },
        },
        slug: "slug:/repo",
        projectLabel: "PawWork",
        created: 800,
      },
    ])
  })

  test("falls back to session creation time when messages are missing", () => {
    const result = buildPawworkSidebarSessionRows(
      [
        {
          id: "session-without-cache",
          directory: "/repo",
          time: { created: 300, updated: 900 },
        },
      ],
      {
        slugForDirectory: (directory) => `slug:${directory}`,
        projectLabelForSession: () => "PawWork",
      },
    )

    expect(result[0].created).toBe(300)
  })
})

describe("pawworkSidebarSessionTime", () => {
  test("uses the latest loaded user message time", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "assistant", time: { created: 700 } },
          { id: "msg_2", role: "user", time: { created: 300 } },
          { id: "msg_3", role: "user", time: { created: 500 } },
        ],
      ),
    ).toBe(500)
  })

  test("ignores user messages without a valid created time", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "user", time: { created: 300 } },
          { id: "msg_2", role: "user", time: {} },
        ],
      ),
    ).toBe(300)
  })

  test("ignores user messages with non-finite created times", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 600,
          },
        },
        [
          { id: "msg_1", role: "user", time: { created: 300 } },
          { id: "msg_2", role: "user", time: { created: Number.NaN } },
          { id: "msg_3", role: "user", time: { created: Number.POSITIVE_INFINITY } },
        ],
      ),
    ).toBe(300)
  })

  test("uses the session creation time instead of last update time when messages are missing", () => {
    expect(
      pawworkSidebarSessionTime(
        {
          time: {
            created: 100,
            updated: 300,
          },
        },
        undefined,
      ),
    ).toBe(100)
  })

  test("falls back to 0 when creation time is non-finite", () => {
    expect(pawworkSidebarSessionTime({ time: { created: Number.NaN, updated: 300 } })).toBe(0)
  })

  test("falls back to 0 when creation time is missing", () => {
    expect(pawworkSidebarSessionTime({ time: { updated: 300 } })).toBe(0)
  })
})
