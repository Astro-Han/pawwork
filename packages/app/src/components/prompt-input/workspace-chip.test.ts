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

  expect(result).toEqual(["/repo/main", "/repo/feature-a", "/repo/analytics"])
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

  expect(result).toEqual(["/repo/feature-c", "/repo/main", "/repo/feature-a", "/repo/analytics"])
})
