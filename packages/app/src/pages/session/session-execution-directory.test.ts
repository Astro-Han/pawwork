import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  createSessionExecutionState,
  type SessionExecutionDirectoryInfo,
  sessionExecutionDirectory,
} from "./session-execution-directory"

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
    expect(sessionExecutionDirectory({ routeDirectory: "/repo", session: null })).toBe("/repo")
    expect(sessionExecutionDirectory({ routeDirectory: "/repo", session: { executionContext: null } })).toBe("/repo")
    expect(
      sessionExecutionDirectory({
        routeDirectory: "/repo",
        session: { executionContext: { activeDirectory: null } },
      }),
    ).toBe("/repo")
  })

  test("shares active-directory selection between review directory and execution scope", () => {
    createRoot((dispose) => {
      const [serverKey, setServerKey] = createSignal("sidecar")
      const [session, setSession] = createSignal<SessionExecutionDirectoryInfo | undefined>()
      const execution = createSessionExecutionState({
        serverKey,
        routeDirectory: () => "/repo",
        session,
      })

      const routeScope = execution.scope()
      expect(execution.directory()).toBe("/repo")
      expect(routeScope).toEqual({ serverKey: "sidecar", directory: "/repo", epoch: 0 })

      setSession({ executionContext: { activeDirectory: "/repo/.worktrees/feature" } })
      const worktreeScope = execution.scope()
      expect(execution.directory()).toBe("/repo/.worktrees/feature")
      expect(worktreeScope).toEqual({ serverKey: "sidecar", directory: "/repo/.worktrees/feature", epoch: 1 })

      setSession({ executionContext: { activeDirectory: null } })
      expect(execution.directory()).toBe("/repo")
      expect(execution.scope()).toEqual({ serverKey: "sidecar", directory: "/repo", epoch: 2 })

      setServerKey("remote")
      expect(execution.scope()).toEqual({ serverKey: "remote", directory: "/repo", epoch: 3 })

      dispose()
    })
  })
})
