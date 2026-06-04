import { describe, expect, test } from "bun:test"
import { sessionExecutionDirectory } from "./session-execution-directory"

describe("session execution directory", () => {
  test("uses the active execution directory when a session is inside a worktree", () => {
    expect(
      sessionExecutionDirectory({
        routeDirectory: "/repo",
        session: {
          executionContext: {
            activeDirectory: "/repo/.worktrees/feature",
          },
        },
      }),
    ).toBe("/repo/.worktrees/feature")
  })

  test("falls back to the route directory before session context is available", () => {
    expect(sessionExecutionDirectory({ routeDirectory: "/repo", session: undefined })).toBe("/repo")
    expect(sessionExecutionDirectory({ routeDirectory: "/repo", session: { executionContext: null } })).toBe("/repo")
  })

  test("wires review VCS state to the shared execution directory", async () => {
    const source = await Bun.file(new URL("../session.tsx", import.meta.url)).text()
    const currentScopeBlock = source.match(/const currentExecutionScope[\s\S]*?const reviewState =/)?.[0]
    const vcsRefreshBlock = source.match(/useSessionVcsRefresh\(\{[\s\S]*?\n  \}\)/)?.[0]

    expect(source).toContain("sessionExecutionDirectory")
    expect(currentScopeBlock).toContain("directory: currentExecutionDirectory()")
    expect(vcsRefreshBlock).toContain("directory: currentExecutionDirectory")
  })
})
