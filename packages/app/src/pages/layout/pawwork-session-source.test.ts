import { describe, expect, test } from "bun:test"
import { resolvePawworkProjectLabels, sortPawworkSidebarSessions } from "./pawwork-session-source"

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
  test("sorts sessions globally by most recent update before project label", () => {
    const result = sortPawworkSidebarSessions([
      { id: "older-a", updated: 100, projectLabel: "alpha" },
      { id: "newer-b", updated: 300, projectLabel: "beta" },
      { id: "middle-a", updated: 200, projectLabel: "alpha" },
    ])

    expect(result.map((item) => item.id)).toEqual(["newer-b", "middle-a", "older-a"])
  })
})
