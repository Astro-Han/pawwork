import { expect, test } from "bun:test"

import { findWorkspaceProject, workspaceChipChoices } from "./workspace-chip-helpers"

test("findWorkspaceProject matches sandboxes with normalized workspace keys", () => {
  const project = findWorkspaceProject(
    [
      {
        worktree: "/repo/main",
        sandboxes: ["/repo/feature-a", "/repo/feature-b"],
      },
    ],
    "/repo/feature-a/",
  )

  expect(project?.worktree).toBe("/repo/main")
})

test("workspaceChipChoices lists project roots for global switching", () => {
  const result = workspaceChipChoices({
    directory: "/repo/main",
    projects: [
      {
        worktree: "/repo/main",
        sandboxes: ["/repo/feature-a"],
      },
      {
        worktree: "/repo/analytics",
      },
    ],
  })

  expect(result.map((c) => c.path)).toEqual(["/repo/main", "/repo/analytics"])
})

test("workspaceChipChoices preserves current directory when it is not part of the known project list", () => {
  const result = workspaceChipChoices({
    directory: "/repo/feature-c",
    projects: [
      {
        worktree: "/repo/main",
        sandboxes: ["/repo/feature-a"],
      },
      {
        worktree: "/repo/analytics",
      },
    ],
  })

  expect(result.map((c) => c.path)).toEqual(["/repo/feature-c", "/repo/main", "/repo/analytics"])
})

test("workspaceChipChoices omits known worktrees from the homepage workspace list", () => {
  const result = workspaceChipChoices({
    directory: "/repo/feature-a",
    projects: [
      {
        worktree: "/repo/main",
        sandboxes: ["/repo/feature-a"],
      },
      {
        worktree: "/repo/analytics",
      },
    ],
  })

  expect(result.map((c) => c.path)).toEqual(["/repo/main", "/repo/analytics"])
})

test("each choice exposes path field for sub-label rendering", () => {
  const result = workspaceChipChoices({
    directory: "/repo/main",
    projects: [{ worktree: "/repo/main" }],
  })

  expect(result[0]).toHaveProperty("path")
  expect(typeof result[0].path).toBe("string")
})

test("workspaceChipChoices ignores listed worktrees", () => {
  const result = workspaceChipChoices({
    directory: "/repo/main",
    projects: [
      {
        worktree: "/repo/main",
        sandboxes: ["/repo/feature-a"],
      },
    ],
    // @ts-expect-error listed is intentionally no longer part of the public helper input.
    listed: [{ directory: "/repo/feature-b" }],
  })

  expect(result.map((c) => c.path)).toEqual(["/repo/main"])
})
