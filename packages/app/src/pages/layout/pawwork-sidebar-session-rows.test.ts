import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  buildPawworkSidebarSessionRows,
  PAWWORK_DIRECT_START_PROJECT_KEY,
  pawworkSessionRouteUnhideKeys,
  resolvePawworkProjectRenameTarget,
  resolvePawworkSessionProjectKey,
  resolvePawworkSessionProjectLabel,
} from "./pawwork-session-source"

describe("buildPawworkSidebarSessionRows", () => {
  test("keeps the parent root group hidden when syncing a subfolder session route", () => {
    const hidden: Record<string, boolean> = { "/repo/packages/app": true, "/repo": true }

    for (const key of pawworkSessionRouteUnhideKeys("/repo/packages/app")) {
      delete hidden[key]
    }

    expect(hidden).toEqual({ "/repo": true })
  })

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

  test("labels default-directory sessions as direct start instead of the backing folder", () => {
    const session = {
      id: "session-direct",
      directory: "/Users/demo/.pawwork",
      project: { id: "proj_default", name: "Backend Project", worktree: "/Users/demo/.pawwork" },
      time: { created: 100, updated: 100 },
    }

    const result = buildPawworkSidebarSessionRows([session], {
      slugForDirectory: (directory) => `slug:${directory}`,
      projectKeyForSession: (item) =>
        resolvePawworkSessionProjectKey(item, { directStartDirectory: "/Users/demo/.pawwork" }),
      projectLabelForSession: (item) =>
        resolvePawworkSessionProjectLabel(item, {
          projects: [],
          directStartDirectory: "/Users/demo/.pawwork",
          directStartLabel: "Direct start",
        }),
    })

    expect(result[0].slug).toBe("slug:/Users/demo/.pawwork")
    expect(result[0].projectKey).toBe(PAWWORK_DIRECT_START_PROJECT_KEY)
    expect(result[0].projectLabel).toBe("Direct start")
  })

  test("keeps default-directory sessions project-manageable when the directory is an opened project", () => {
    const directStartDirectory = "/Users/demo/PawWork"
    const project = { id: "proj_pawwork", name: "Default Project", worktree: directStartDirectory }
    const session = {
      id: "session-project",
      directory: directStartDirectory,
      time: { created: 100, updated: 100 },
    }
    const sessionSource = { directStartDirectory, projects: [project] }

    const result = buildPawworkSidebarSessionRows([session], {
      slugForDirectory: (directory) => `slug:${directory}`,
      projectKeyForSession: (item) => resolvePawworkSessionProjectKey(item, sessionSource),
      projectLabelForSession: (item) =>
        resolvePawworkSessionProjectLabel(item, {
          projects: [project],
          directStartDirectory,
          directStartLabel: "Direct start",
        }),
    })

    expect(result[0].projectKey).toBe(directStartDirectory)
    expect(result[0].projectLabel).toBe("Default Project")
    expect(resolvePawworkProjectRenameTarget(result[0].projectKey, { projects: [project], sessions: [session] })).toEqual({
      type: "project",
      project,
    })
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
