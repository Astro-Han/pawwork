import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Session } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import type { SubagentRun } from "../../src/session/subagent-run"
import { hasInFlightToolCallsExcept, hasRunningSubagents } from "../../src/session/state-machine-guard"

const sessionID = "session_test" as SessionID

function sessionsWithParts(parts: unknown[]): Session.Service["Service"] {
  return {
    messages: () => Effect.succeed([{ parts }]),
  } as unknown as Session.Service["Service"]
}

function toolPart(callID: string, status: string) {
  return {
    type: "tool",
    tool: "bash",
    callID,
    state: { status },
  }
}

function subagents(active: boolean): SubagentRun.Service["Service"] {
  return {
    activeForSession: () => Effect.succeed(active),
  } as unknown as SubagentRun.Service["Service"]
}

describe("state-machine guard", () => {
  test("detects pending and running tool calls except the current call", async () => {
    const sessions = sessionsWithParts([
      toolPart("current", "running"),
      toolPart("other-pending", "pending"),
      toolPart("other-running", "running"),
    ])

    const blocked = await Effect.runPromise(hasInFlightToolCallsExcept(sessions, sessionID, "current"))

    expect(blocked).toBe(true)
  })

  test("detects pending tool calls except the current call", async () => {
    const sessions = sessionsWithParts([toolPart("current", "running"), toolPart("other-pending", "pending")])

    const blocked = await Effect.runPromise(hasInFlightToolCallsExcept(sessions, sessionID, "current"))

    expect(blocked).toBe(true)
  })

  test("detects running tool calls except the current call", async () => {
    const sessions = sessionsWithParts([toolPart("current", "running"), toolPart("other-running", "running")])

    const blocked = await Effect.runPromise(hasInFlightToolCallsExcept(sessions, sessionID, "current"))

    expect(blocked).toBe(true)
  })

  test("ignores the current call and finished tool calls", async () => {
    const sessions = sessionsWithParts([
      toolPart("current", "running"),
      toolPart("done", "completed"),
      toolPart("failed", "error"),
      { type: "text", text: "not a tool" },
    ])

    const blocked = await Effect.runPromise(hasInFlightToolCallsExcept(sessions, sessionID, "current"))

    expect(blocked).toBe(false)
  })

  test("reports active subagents", async () => {
    await expect(Effect.runPromise(hasRunningSubagents(subagents(true), sessionID))).resolves.toBe(true)
    await expect(Effect.runPromise(hasRunningSubagents(subagents(false), sessionID))).resolves.toBe(false)
  })
})
