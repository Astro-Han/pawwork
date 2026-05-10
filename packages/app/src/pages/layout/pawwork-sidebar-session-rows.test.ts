import { describe, expect, test } from "bun:test"
import { buildPawworkSidebarSessionRows } from "./pawwork-session-source"

describe("buildPawworkSidebarSessionRows", () => {
  test("uses API activity time before loaded message cache for sidebar rows", () => {
    const result = buildPawworkSidebarSessionRows(
      [
        {
          id: "session-old",
          directory: "/repo",
          activityAt: 900,
          time: { created: 100, updated: 950 },
        },
      ],
      {
        slugForDirectory: (directory) => `slug:${directory}`,
        projectKeyForSession: () => "pawwork",
        projectKeyForSession: () => "pawwork",
        projectLabelForSession: () => "PawWork",
        messagesForSession: () => [{ id: "msg_1", role: "user", time: { created: 800 } }],
      },
    )

    expect(result[0].created).toBe(900)
  })

  test("does not let unqualified loaded user message cache override API activity time", () => {
    const result = buildPawworkSidebarSessionRows(
      [
        {
          id: "session-old",
          directory: "/repo",
          activityAt: 700,
          time: { created: 100, updated: 950 },
        },
      ],
      {
        slugForDirectory: (directory) => `slug:${directory}`,
        projectKeyForSession: () => "pawwork",
        projectKeyForSession: () => "pawwork",
        projectLabelForSession: () => "PawWork",
        messagesForSession: () => [{ id: "msg_1", role: "user", time: { created: 900 } }],
      },
    )

    expect(result[0].created).toBe(700)
  })

  test("uses fresher loaded real user message parts over stale API activity time", () => {
    const result = buildPawworkSidebarSessionRows(
      [
        {
          id: "session-old",
          directory: "/repo",
          activityAt: 700,
          time: { created: 100, updated: 950 },
        },
      ],
      {
        slugForDirectory: (directory) => `slug:${directory}`,
        projectKeyForSession: () => "pawwork",
        projectLabelForSession: () => "PawWork",
        messagesForSession: () => [{ id: "msg_1", role: "user", time: { created: 900 } }],
        partsForMessage: (_session, messageID) =>
          messageID === "msg_1" ? [{ type: "text", synthetic: false }] : undefined,
      },
    )

    expect(result[0].created).toBe(900)
  })

  test("does not let loaded synthetic-only user message parts override API activity time", () => {
    const result = buildPawworkSidebarSessionRows(
      [
        {
          id: "session-old",
          directory: "/repo",
          activityAt: 700,
          time: { created: 100, updated: 950 },
        },
      ],
      {
        slugForDirectory: (directory) => `slug:${directory}`,
        projectKeyForSession: () => "pawwork",
        projectLabelForSession: () => "PawWork",
        messagesForSession: () => [{ id: "msg_1", role: "user", time: { created: 900 } }],
        partsForMessage: (_session, messageID) =>
          messageID === "msg_1" ? [{ type: "text", synthetic: true }] : undefined,
      },
    )

    expect(result[0].created).toBe(700)
  })

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
        projectKeyForSession: () => "pawwork",
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
        projectKey: "pawwork",
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
        projectKeyForSession: () => "pawwork",
        projectLabelForSession: () => "PawWork",
      },
    )

    expect(result[0].created).toBe(300)
  })
})
