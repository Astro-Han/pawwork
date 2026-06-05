import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  buildPawworkSidebarSessionRows,
  filterPawworkRowsByOpenProjects,
  resolvePawworkProjectRenameTarget,
  resolvePawworkSessionProjectKey,
  resolvePawworkSessionProjectLabel,
} from "./pawwork-session-source"

describe("filterPawworkRowsByOpenProjects", () => {
  const row = (directory: string, projectWorktree?: string) => ({
    session: { id: `s:${directory}`, directory, project: projectWorktree ? { worktree: projectWorktree } : undefined },
  })

  test("keeps a row whose owning project root is open", () => {
    const result = filterPawworkRowsByOpenProjects([row("/repo", "/repo")], [{ worktree: "/repo" }])
    expect(result).toHaveLength(1)
  })

  test("drops a row whose owning project is not in the open project list", () => {
    const result = filterPawworkRowsByOpenProjects([row("/repo", "/repo")], [{ worktree: "/other" }])
    expect(result).toHaveLength(0)
  })

  test("keeps a subfolder session of an open project", () => {
    const result = filterPawworkRowsByOpenProjects([row("/repo/packages/app", "/repo")], [{ worktree: "/repo" }])
    expect(result).toHaveLength(1)
  })

  test("keeps a subfolder session resolved via executionContext.ownerDirectory when project is absent", () => {
    // session.get backfill (active / pinned sessions off the first page) returns
    // a plain Session with no `project` field; ownerDirectory still points at the
    // open root, so the row must survive.
    const result = filterPawworkRowsByOpenProjects(
      [{ session: { id: "s1", directory: "/repo/packages/app", executionContext: { ownerDirectory: "/repo" } } }],
      [{ worktree: "/repo" }],
    )
    expect(result).toHaveLength(1)
  })

  test("keeps a sandbox session matched by sandbox path when project worktree is absent", () => {
    const result = filterPawworkRowsByOpenProjects(
      [row("/repo-worktree")],
      [{ worktree: "/repo", sandboxes: ["/repo-worktree"] }],
    )
    expect(result).toHaveLength(1)
  })

  test("drops every row when no project is open", () => {
    const result = filterPawworkRowsByOpenProjects([row("/repo", "/repo"), row("/other", "/other")], [])
    expect(result).toHaveLength(0)
  })
})

describe("buildPawworkSidebarSessionRows", () => {
  test("renames sandbox session groups as local workspace labels", () => {
    const project = { id: "proj_repo", name: "Repo", worktree: "/repo", sandboxes: ["/repo-worktree"] }
    let renamedProject: typeof project | undefined
    const workspaceName: Record<string, string> = {}

    const target = resolvePawworkProjectRenameTarget("/repo-worktree", {
      projects: [project],
      sessions: [
        {
          id: "session-sandbox",
          directory: "/repo-worktree",
          project: { id: "proj_repo", name: "Repo", worktree: "/repo" },
          time: { created: 100, updated: 100 },
        },
      ],
    })

    if (target?.type === "project") renamedProject = target.project
    if (target?.type === "workspace") workspaceName[target.directory] = "Feature"

    expect(renamedProject).toBeUndefined()
    expect(workspaceName).toEqual({ "/repo-worktree": "Feature" })
  })

  test("renames root project groups as projects", () => {
    const project = { id: "proj_repo", name: "Repo", worktree: "/repo", sandboxes: ["/repo-feature"] }

    const target = resolvePawworkProjectRenameTarget("/repo", {
      projects: [project],
      sessions: [],
    })

    expect(target).toEqual({ type: "project", project })
  })

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
    const source = readFileSync(new URL("./pawwork-session-controller.ts", import.meta.url), "utf8")

    expect(source).not.toContain("globalSync.child(session.directory, { bootstrap: false, pin: false })")
    expect(source).toContain("input.globalSync.peekExisting(session.directory)")
    expect(source).toContain("return tuple?.[0].message[session.id]")
    expect(source).toContain("return tuple?.[0].part[messageID]")
  })
})
