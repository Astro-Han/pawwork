import { describe, expect, test } from "bun:test"
import { resolvePawworkProjectLabels } from "./pawwork-session-source"

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
