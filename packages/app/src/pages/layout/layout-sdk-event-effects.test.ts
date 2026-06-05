import { describe, expect, test } from "bun:test"
import {
  createSDKNotificationEventHandler,
  isCurrentOrDescendantSession,
  permissionSessionKey,
  sessionNotificationHref,
  shouldThrottlePermissionAlert,
} from "./layout-sdk-event-effects"

type TestEvent = Parameters<ReturnType<typeof createSDKNotificationEventHandler>>[0]

function permissionAskedEvent(directory: string, sessionID: string): TestEvent {
  return {
    name: directory,
    details: {
      type: "permission.asked",
      properties: {
        id: "perm_1",
        sessionID,
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      },
    },
  } as unknown as TestEvent
}

function createSDKNotificationHarness(input?: {
  currentSessionID?: string
  notifyLevel?: "never" | "unfocused" | "always"
  now?: () => number
}) {
  let sessionsCalls = 0
  const notifications: Array<{ title: string; description?: string; href?: string }> = []
  const sounds: string[] = []
  const sessions = [
    { id: "ses_root", title: "Root session" },
    { id: "ses_child", parentID: "ses_root", title: "Child session" },
    { id: "ses_other", title: "Other session" },
  ]

  const handler = createSDKNotificationEventHandler({
    route: {
      currentDirectory: () => "/repo",
      currentSessionID: () => input?.currentSessionID,
      sessionHref: sessionNotificationHref,
    },
    sdk: {
      sessions: () => {
        sessionsCalls += 1
        return sessions
      },
    },
    settings: {
      notify: {
        level: () => input?.notifyLevel ?? "unfocused",
      },
    },
    permission: {
      autoResponds: () => false,
    },
    effects: {
      notify: (title, description, href) => {
        notifications.push({ title, description, href })
      },
      playSound: (id: string) => { sounds.push(id) },
      setBusy: () => undefined,
      worktreeReady: () => undefined,
      worktreeFailed: () => undefined,
    },
    copy: {
      t: (key, params) => `${key}:${params?.sessionTitle ?? ""}:${params?.projectName ?? ""}`,
    },
    now: input?.now,
  })

  return {
    emit(event: TestEvent) {
      handler(event)
    },
    notifications,
    sounds,
    sessionsCalls: () => sessionsCalls,
  }
}

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

  test("builds a stable permission cleanup key", () => {
    expect(permissionSessionKey("/repo", "ses_1")).toBe("/repo:ses_1")
  })

  test("throttles permission alerts within cooldown only", () => {
    expect(shouldThrottlePermissionAlert(1000, 5999, 5000)).toBe(true)
    expect(shouldThrottlePermissionAlert(1000, 6000, 5000)).toBe(false)
    expect(shouldThrottlePermissionAlert(undefined, 1000, 5000)).toBe(false)
  })

  test("does not look up permission title while cooldown applies", () => {
    let time = 1000
    const hook = createSDKNotificationHarness({ now: () => time })
    hook.emit(permissionAskedEvent("/repo", "ses_other"))
    time = 2000
    hook.emit(permissionAskedEvent("/repo", "ses_other"))

    expect(hook.sessionsCalls()).toBe(1)
    expect(hook.notifications).toHaveLength(1)
  })

  test("plays notify sound for permission alerts", () => {
    const hook = createSDKNotificationHarness()
    hook.emit(permissionAskedEvent("/repo", "ses_other"))

    expect(hook.sounds).toEqual(["notify"])
  })
})
