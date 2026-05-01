import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import type { Session } from "../../src/session"
import type { SessionID } from "../../src/session/schema"
import type { SubagentRun } from "../../src/session/subagent-run"
import { hasInFlightToolCallsExcept, hasRunningSubagents } from "../../src/session/state-machine-guard"

const sessionID = "session_test" as SessionID
const it = testEffect(Layer.empty)

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
  it.live("detects pending and running tool calls except the current call", () =>
    Effect.gen(function* () {
      const sessions = sessionsWithParts([
        toolPart("current", "running"),
        toolPart("other-pending", "pending"),
        toolPart("other-running", "running"),
      ])

      const blocked = yield* hasInFlightToolCallsExcept(sessions, sessionID, "current")

      expect(blocked).toBe(true)
    }),
  )

  it.live("detects pending tool calls except the current call", () =>
    Effect.gen(function* () {
      const sessions = sessionsWithParts([toolPart("current", "running"), toolPart("other-pending", "pending")])

      const blocked = yield* hasInFlightToolCallsExcept(sessions, sessionID, "current")

      expect(blocked).toBe(true)
    }),
  )

  it.live("detects running tool calls except the current call", () =>
    Effect.gen(function* () {
      const sessions = sessionsWithParts([toolPart("current", "running"), toolPart("other-running", "running")])

      const blocked = yield* hasInFlightToolCallsExcept(sessions, sessionID, "current")

      expect(blocked).toBe(true)
    }),
  )

  it.live("ignores the current call and finished tool calls", () =>
    Effect.gen(function* () {
      const sessions = sessionsWithParts([
        toolPart("current", "running"),
        toolPart("done", "completed"),
        toolPart("failed", "error"),
        { type: "text", text: "not a tool" },
      ])

      const blocked = yield* hasInFlightToolCallsExcept(sessions, sessionID, "current")

      expect(blocked).toBe(false)
    }),
  )

  it.live("reports active subagents", () =>
    Effect.gen(function* () {
      const activeResult = yield* hasRunningSubagents(subagents(true), sessionID)
      expect(activeResult).toBe(true)

      const inactiveResult = yield* hasRunningSubagents(subagents(false), sessionID)
      expect(inactiveResult).toBe(false)
    }),
  )
})
