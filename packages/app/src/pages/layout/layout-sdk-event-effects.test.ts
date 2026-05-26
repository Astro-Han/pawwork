import { describe, expect, test } from "bun:test"
import {
  createSDKNotificationEventHandler,
  isCurrentOrDescendantSession,
  permissionSessionKey,
  questionCallKey,
  questionNotificationAction,
  sessionNotificationHref,
  shouldThrottlePermissionAlert,
} from "./layout-sdk-event-effects"

type TestEvent = Parameters<ReturnType<typeof createSDKNotificationEventHandler>>[0]

function questionUpdatedEvent(directory: string, sessionID: string, partID = "prt_1"): TestEvent {
  return {
    name: directory,
    details: {
      type: "message.part.updated",
      properties: {
        sessionID,
        part: {
          id: partID,
          type: "tool",
          tool: "question",
          state: { status: "running", metadata: { externalResultReady: true } },
        },
      },
    },
  } as unknown as TestEvent
}

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
      playSound: () => undefined,
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

  test("does not look up sessions for current-route question notifications", () => {
    const hook = createSDKNotificationHarness({ currentSessionID: "ses_root" })
    hook.emit(questionUpdatedEvent("/repo", "ses_root"))

    expect(hook.sessionsCalls()).toBe(0)
    expect(hook.notifications).toHaveLength(0)
  })

  test("does not look up sessions when question notifications are disabled", () => {
    const hook = createSDKNotificationHarness({ notifyLevel: "never" })
    hook.emit(questionUpdatedEvent("/repo", "ses_other"))

    expect(hook.sessionsCalls()).toBe(0)
    expect(hook.notifications).toHaveLength(0)
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

  test("reuses one session snapshot when notifying for a question", () => {
    const hook = createSDKNotificationHarness({ currentSessionID: "ses_root" })
    hook.emit(questionUpdatedEvent("/repo", "ses_other"))

    expect(hook.sessionsCalls()).toBe(1)
    expect(hook.notifications).toEqual([
      {
        title: "notification.question.title::",
        description: "notification.question.description:Other session:repo",
        href: sessionNotificationHref("/repo", "ses_other"),
      },
    ])
  })
})
