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
})
