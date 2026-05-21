import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  buildPawworkSidebarSessionRows,
  resolvePawworkSessionProjectKey,
  resolvePawworkSessionProjectLabel,
} from "./pawwork-session-source"

describe("buildPawworkSidebarSessionRows", () => {
  test("groups git subfolder sessions by the opened directory instead of the repo root", () => {
    const session = {
      id: "session-subfolder",
      directory: "/repo/packages/app",
      project: { id: "proj_repo", name: "Repo", worktree: "/repo" },
      time: { created: 100, updated: 100 },
    }
    const projects = [{ id: "proj_repo", name: "Repo", worktree: "/repo" }]

    const result = buildPawworkSidebarSessionRows([session], {
      slugForDirectory: (directory) => `slug:${directory}`,
      projectKeyForSession: (item) => resolvePawworkSessionProjectKey(item),
      projectLabelForSession: (item) => resolvePawworkSessionProjectLabel(item, { projects }),
    })

    expect(result[0].projectKey).toBe("/repo/packages/app")
    expect(result[0].projectLabel).toBe("app")
  })

  test("keeps project names for sessions opened at the project root", () => {
    const session = {
      id: "session-root",
      directory: "/repo",
      project: { id: "proj_repo", name: "Repo", worktree: "/repo" },
      time: { created: 100, updated: 100 },
    }

    const result = buildPawworkSidebarSessionRows([session], {
      slugForDirectory: (directory) => `slug:${directory}`,
      projectKeyForSession: (item) => resolvePawworkSessionProjectKey(item),
      projectLabelForSession: (item) => resolvePawworkSessionProjectLabel(item, { projects: [] }),
    })

    expect(result[0].projectKey).toBe("/repo")
    expect(result[0].projectLabel).toBe("Repo")
  })

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

  test("layout sidebar timestamp cache reads do not create child stores", () => {
    const source = readFileSync(new URL("../layout.tsx", import.meta.url), "utf8")

    expect(source).not.toContain("globalSync.child(session.directory, { bootstrap: false, pin: false })")
    expect(source).toContain("const tuple = globalSync.peekExisting(session.directory)")
    expect(source).toContain("return tuple?.[0].message[session.id]")
    expect(source).toContain("return tuple?.[0].part[messageID]")
  })
})
