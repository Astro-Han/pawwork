import { describe, expect, test } from "bun:test"
import {
  createExecutionScopeTracker,
  executionScopeKey,
  nextExecutionEpoch,
  sameExecutionScope,
  shouldApplyExecutionResult,
  vcsTaskKey,
} from "./execution-scope"

describe("execution scope", () => {
  test("keys include server directory and epoch", () => {
    expect(executionScopeKey({ serverKey: "sidecar", directory: "/repo", epoch: 1 })).not.toBe(
      executionScopeKey({ serverKey: "sidecar", directory: "/repo", epoch: 2 }),
    )
    expect(executionScopeKey({ serverKey: "sidecar", directory: "/repo", epoch: 1 })).not.toBe(
      executionScopeKey({ serverKey: "sidecar", directory: "/repo-wt", epoch: 1 }),
    )
  })

  test("increments epoch monotonically", () => {
    expect(nextExecutionEpoch(0)).toBe(1)
    expect(nextExecutionEpoch(41)).toBe(42)
  })

  test("tracker bumps epoch synchronously on server or directory change", () => {
    const tracker = createExecutionScopeTracker()

    const a1 = tracker({ serverKey: "sidecar", directory: "/repo" })
    const sameA = tracker({ serverKey: "sidecar", directory: "/repo" })
    const b2 = tracker({ serverKey: "sidecar", directory: "/repo-wt" })
    const a3 = tracker({ serverKey: "sidecar", directory: "/repo" })
    const remoteA = tracker({ serverKey: "remote", directory: "/repo" })

    expect(a1).toEqual({ serverKey: "sidecar", directory: "/repo", epoch: 0 })
    expect(sameA).toBe(a1)
    expect(b2).toEqual({ serverKey: "sidecar", directory: "/repo-wt", epoch: 1 })
    expect(a3).toEqual({ serverKey: "sidecar", directory: "/repo", epoch: 2 })
    expect(remoteA).toEqual({ serverKey: "remote", directory: "/repo", epoch: 3 })
  })

  test("ignores stale result after A to B to A reuse", () => {
    const oldA = { serverKey: "sidecar", directory: "/repo", epoch: 1 }
    const newA = { serverKey: "sidecar", directory: "/repo", epoch: 3 }

    expect(shouldApplyExecutionResult({ requested: oldA, current: newA })).toBe(false)
    expect(shouldApplyExecutionResult({ requested: newA, current: newA })).toBe(true)
  })

  test("vcs task key includes execution scope", () => {
    const oldA = vcsTaskKey({ serverKey: "sidecar", directory: "/repo", epoch: 1 }, "unstaged")
    const newA = vcsTaskKey({ serverKey: "sidecar", directory: "/repo", epoch: 3 }, "unstaged")

    expect(oldA).not.toBe(newA)
  })

  test("compares all fields", () => {
    expect(
      sameExecutionScope(
        { serverKey: "sidecar", directory: "/repo", epoch: 1 },
        { serverKey: "sidecar", directory: "/repo", epoch: 1 },
      ),
    ).toBe(true)
    expect(
      sameExecutionScope(
        { serverKey: "sidecar", directory: "/repo", epoch: 1 },
        { serverKey: "remote", directory: "/repo", epoch: 1 },
      ),
    ).toBe(false)
  })
})
