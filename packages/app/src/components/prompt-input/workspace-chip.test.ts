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

test("workspaceChipChoices lists all known project directories for global switching", () => {
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

  expect(result.map((c) => c.path)).toEqual(["/repo/main", "/repo/feature-a", "/repo/analytics"])
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

  expect(result.map((c) => c.path)).toEqual(["/repo/feature-c", "/repo/main", "/repo/feature-a", "/repo/analytics"])
})

test("each choice exposes path field for sub-label rendering", () => {
  const result = workspaceChipChoices({
    directory: "/repo/main",
    projects: [{ worktree: "/repo/main" }],
  })

  expect(result[0]).toHaveProperty("path")
  expect(typeof result[0].path).toBe("string")
})

test("branch field is optional (not required when SDK can't resolve)", () => {
  const result = workspaceChipChoices({
    directory: "/repo/main",
    projects: [{ worktree: "/repo/main" }],
  })

  expect(result[0].branch === undefined || typeof result[0].branch === "string").toBe(true)
})

test("workspaceChipChoices preserves branch metadata after workspace ordering", () => {
  const result = workspaceChipChoices({
    directory: "/repo/feature-a",
    projects: [
      {
        worktree: "/repo/main",
        sandboxes: [{ directory: "/repo/feature-a", branch: "pawwork/feature-a" }],
      },
    ],
    listed: [{ directory: "/repo/feature-b", branch: "pawwork/feature-b" }],
  })

  expect(result).toEqual([
    { path: "/repo/main", branch: undefined },
    { path: "/repo/feature-a", branch: "pawwork/feature-a" },
    { path: "/repo/feature-b", branch: "pawwork/feature-b" },
  ])
})
