import { describe, expect, test } from "bun:test"
import {
  isCurrentOrDescendantSession,
  permissionSessionKey,
  questionCallKey,
  questionNotificationAction,
  shouldThrottlePermissionAlert,
} from "./layout-sdk-event-effects"

describe("layout sdk event effects", () => {
  test("matches the current session in the active workspace", () => {
    expect(
      isCurrentOrDescendantSession({
        directory: "/repo/worktree/",
        sessionID: "ses_current",
        currentDirectory: "/repo/worktree",
        currentSessionID: "ses_current",
        sessions: [],
      }),
    ).toBe(true)
  })

  test("matches descendant sessions under the active session", () => {
    expect(
      isCurrentOrDescendantSession({
        directory: "/repo/worktree",
        sessionID: "ses_leaf",
        currentDirectory: "/repo/worktree",
        currentSessionID: "ses_root",
        sessions: [
          { id: "ses_root" },
          { id: "ses_child", parentID: "ses_root" },
          { id: "ses_leaf", parentID: "ses_child" },
        ],
      }),
    ).toBe(true)
  })

  test("does not match sessions from another workspace", () => {
    expect(
      isCurrentOrDescendantSession({
        directory: "/repo/other",
        sessionID: "ses_current",
        currentDirectory: "/repo/worktree",
        currentSessionID: "ses_current",
        sessions: [{ id: "ses_current" }],
      }),
    ).toBe(false)
  })

  test("stops descendant walks on parent cycles", () => {
    expect(
      isCurrentOrDescendantSession({
        directory: "/repo/worktree",
        sessionID: "ses_leaf",
        currentDirectory: "/repo/worktree",
        currentSessionID: "ses_root",
        sessions: [
          { id: "ses_leaf", parentID: "ses_a" },
          { id: "ses_a", parentID: "ses_b" },
          { id: "ses_b", parentID: "ses_a" },
        ],
      }),
    ).toBe(false)
  })

  test("builds stable cleanup keys", () => {
    expect(permissionSessionKey("/repo", "ses_1")).toBe("/repo:ses_1")
    expect(questionCallKey("/repo", "ses_1", "prt_1")).toBe("/repo:ses_1:prt_1")
  })

  test("resets question dedupe when the question part is no longer running", () => {
    expect(
      questionNotificationAction({
        type: "tool",
        tool: "question",
        state: { status: "completed", metadata: { externalResultReady: true } },
      }),
    ).toBe("reset")
  })

  test("notifies only after an external question route is ready", () => {
    expect(
      questionNotificationAction({
        type: "tool",
        tool: "question",
        state: { status: "running", metadata: { externalResultReady: true } },
      }),
    ).toBe("notify")
    expect(
      questionNotificationAction({
        type: "tool",
        tool: "question",
        state: { status: "running", metadata: { externalResultReady: false } },
      }),
    ).toBe("ignore")
  })

  test("throttles permission alerts within cooldown only", () => {
    expect(shouldThrottlePermissionAlert(1000, 5999, 5000)).toBe(true)
    expect(shouldThrottlePermissionAlert(1000, 6000, 5000)).toBe(false)
    expect(shouldThrottlePermissionAlert(undefined, 1000, 5000)).toBe(false)
  })
})
