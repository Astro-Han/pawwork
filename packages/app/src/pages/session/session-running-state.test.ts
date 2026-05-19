import { describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { isSessionRunning, PENDING_MESSAGE_FALLBACK_MS, runningFallbackExpiresAt } from "./session-running-state"

const idle: SessionStatus = { type: "idle" }
const busy: SessionStatus = { type: "busy" }
const retry: SessionStatus = { type: "retry", attempt: 1, message: "rate limited", next: 1_776_773_000_000 }

const user = (id: string, created: number): Message =>
  ({
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created },
  }) as Message

const assistant = (
  id: string,
  created: number,
  completed?: number,
  finish?: "stop" | "tool-calls",
): Message =>
  ({
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: "msg_user",
    time: completed === undefined ? { created } : { created, completed },
    finish,
  }) as Message

describe("isSessionRunning", () => {
  test("treats undefined status as idle and handles missing messages", () => {
    expect(isSessionRunning(undefined, undefined)).toBe(false)
    expect(isSessionRunning(undefined, [])).toBe(false)
  })

  test("uses latest-message fallback when status is undefined", () => {
    expect(isSessionRunning(undefined, [user("msg_user", 1)])).toBe(false)
    expect(isSessionRunning(undefined, [user("msg_user", 1), assistant("msg_pending", 2)], { now: 10_000 })).toBe(true)
  })

  test("ignores a stale incomplete assistant message when a later assistant completed", () => {
    const messages = [
      user("msg_user_1", 1),
      assistant("msg_stale", 2),
      user("msg_user_2", 3),
      assistant("msg_done", 4, 5, "stop"),
    ]

    expect(isSessionRunning(idle, messages)).toBe(false)
  })

  test("ignores a stale incomplete assistant message when a later user message exists", () => {
    const messages = [user("msg_user_1", 1), assistant("msg_stale", 2), user("msg_user_2", 3)]

    expect(isSessionRunning(idle, messages)).toBe(false)
  })

  test("returns true when live session status is busy", () => {
    expect(isSessionRunning(busy, [assistant("msg_done", 1, 2, "stop")])).toBe(true)
  })

  test("returns true when live session status is retry", () => {
    expect(isSessionRunning(retry, [assistant("msg_done", 1, 2, "stop")])).toBe(true)
  })

  test("returns true when the latest assistant message was just created", () => {
    const messages = [user("msg_user", 1), assistant("msg_pending", 2)]

    expect(isSessionRunning(idle, messages, { now: 10_000 })).toBe(true)
  })

  test("ignores a stale latest assistant message left incomplete by an interrupted turn", () => {
    const messages = [user("msg_user", 1), assistant("msg_stale", 2)]

    expect(isSessionRunning(idle, messages, { now: 40_000 })).toBe(false)
  })

  test("exposes the fallback expiry while the latest assistant message is fresh", () => {
    const messages = [user("msg_user", 1), assistant("msg_pending", 2)]

    expect(runningFallbackExpiresAt(idle, messages, { now: 10_000 })).toBe(2 + PENDING_MESSAGE_FALLBACK_MS)
    expect(runningFallbackExpiresAt(idle, messages, { now: 40_000 })).toBeUndefined()
  })

  test("ignores malformed assistant messages without created time", () => {
    const malformed = { id: "msg_bad", sessionID: "ses_1", role: "assistant" } as Message

    expect(isSessionRunning(idle, [user("msg_user", 1), malformed], { now: 10_000 })).toBe(false)
  })

  test("returns false when there are no messages and status is idle", () => {
    expect(isSessionRunning(idle, [])).toBe(false)
  })

  test("returns false when there are no assistant messages and status is idle", () => {
    expect(isSessionRunning(idle, [user("msg_user", 1)])).toBe(false)
  })
})

const rateLimitBlocked: SessionStatus = {
  type: "rate_limit_blocked",
  classification: {
    kind: "free_quota_exhausted",
    providerID: "opencode" as never, // branded ProviderID — narrow type is enforced server-side
    raw: "x",
  },
}

describe("isSessionRunning — rate_limit_blocked is terminal-visible, not running", () => {
  test("rate_limit_blocked → false", () => {
    expect(isSessionRunning(rateLimitBlocked, [])).toBe(false)
  })
  test("busy → true (control)", () => {
    expect(isSessionRunning(busy, [])).toBe(true)
  })
  test("retry → true (control)", () => {
    expect(isSessionRunning(retry, [])).toBe(true)
  })
  test("idle → false (control)", () => {
    expect(isSessionRunning(idle, [])).toBe(false)
  })
})

describe("runningFallbackExpiresAt — rate_limit_blocked never expects a fallback timer", () => {
  test("rate_limit_blocked → undefined", () => {
    expect(runningFallbackExpiresAt(rateLimitBlocked, [])).toBeUndefined()
  })
})
