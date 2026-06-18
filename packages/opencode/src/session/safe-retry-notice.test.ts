import { expect, test } from "bun:test"
import type { MessageV2 } from "./message-v2"
import { turnHasCompletedSideEffect } from "./safe-retry-notice"

const PARENT = "msg_user_turn" as unknown as NonNullable<MessageV2.Assistant["parentID"]>

// Minimal structural fixtures: the helper only reads info.role, info.parentID,
// part.type, part.state.status, and part.tool.
function assistant(parentID: string, parts: unknown[]): MessageV2.WithParts {
  return { info: { role: "assistant", parentID }, parts } as unknown as MessageV2.WithParts
}
function tool(name: string, status: string) {
  return { type: "tool", tool: name, state: { status } }
}
function notice() {
  return { type: "notice", kind: "safe_retry_failed" }
}

test("side-effecting tool completed on a sibling message of the turn → true", () => {
  // #1358 real topology: bash completed in message A; the notice lands on B.
  const messages = [assistant(PARENT, [tool("bash", "completed")]), assistant(PARENT, [notice()])]
  expect(turnHasCompletedSideEffect(messages, PARENT)).toBe(true)
})

test("only a completed read-only tool → false (no side effect to claim)", () => {
  const messages = [assistant(PARENT, [tool("grep", "completed")]), assistant(PARENT, [notice()])]
  expect(turnHasCompletedSideEffect(messages, PARENT)).toBe(false)
})

test("no tool, only the notice → false", () => {
  expect(turnHasCompletedSideEffect([assistant(PARENT, [notice()])], PARENT)).toBe(false)
})

test("side-effecting tool still running (not completed) → false", () => {
  const messages = [assistant(PARENT, [tool("bash", "running")]), assistant(PARENT, [notice()])]
  expect(turnHasCompletedSideEffect(messages, PARENT)).toBe(false)
})

test("unknown/custom tool counts as side-effecting (errs toward reassurance)", () => {
  const messages = [assistant(PARENT, [tool("deploy_thing", "completed")]), assistant(PARENT, [notice()])]
  expect(turnHasCompletedSideEffect(messages, PARENT)).toBe(true)
})

test("a completed side-effecting tool from a different turn is ignored", () => {
  const messages = [assistant("other_turn", [tool("bash", "completed")]), assistant(PARENT, [notice()])]
  expect(turnHasCompletedSideEffect(messages, PARENT)).toBe(false)
})
