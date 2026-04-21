import { describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { isSessionRunning } from "./session-running-state"

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
    expect(isSessionRunning(undefined, [user("msg_user", 1), assistant("msg_pending", 2)])).toBe(true)
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

  test("returns true when the latest assistant message is incomplete", () => {
    const messages = [user("msg_user", 1), assistant("msg_pending", 2)]

    expect(isSessionRunning(idle, messages)).toBe(true)
  })

  test("returns false when there are no messages and status is idle", () => {
    expect(isSessionRunning(idle, [])).toBe(false)
  })

  test("returns false when there are no assistant messages and status is idle", () => {
    expect(isSessionRunning(idle, [user("msg_user", 1)])).toBe(false)
  })
})
