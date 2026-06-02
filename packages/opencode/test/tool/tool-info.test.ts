import { describe, expect, test } from "bun:test"
import { deriveActivatedTools, buildCardList, DEFERRED_TOOL_IDS } from "../../src/tool/tool-info"
import type { MessageV2 } from "../../src/session/message-v2"

function toolPart(tool: string, status: string, input: Record<string, unknown>) {
  return { type: "tool", tool, callID: "c", state: { status, input } }
}

function assistant(parts: unknown[]): MessageV2.WithParts {
  return { info: { role: "assistant" }, parts } as unknown as MessageV2.WithParts
}

describe("tool-info", () => {
  test("DEFERRED_TOOL_IDS is exactly the two worktree tools", () => {
    expect([...DEFERRED_TOOL_IDS].sort()).toEqual(["enter-worktree", "exit-worktree"])
  })

  test("deriveActivatedTools picks only completed tool_info calls for deferred tools", () => {
    const messages = [
      assistant([toolPart("tool_info", "completed", { name: "enter-worktree" })]),
      assistant([toolPart("tool_info", "running", { name: "exit-worktree" })]), // not completed
      assistant([toolPart("read", "completed", { name: "exit-worktree" })]), // not tool_info
      assistant([toolPart("tool_info", "completed", { name: "not-a-deferred-tool" })]), // not deferred
    ]
    expect([...deriveActivatedTools(messages)]).toEqual(["enter-worktree"])
  })

  test("deriveActivatedTools returns empty when no tool_info calls exist", () => {
    expect(deriveActivatedTools([assistant([toolPart("read", "completed", {})])]).size).toBe(0)
  })

  test("buildCardList lists available deferred tools with their cards", () => {
    const list = buildCardList(["enter-worktree", "exit-worktree"])
    expect(list).toContain("enter-worktree")
    expect(list).toContain("exit-worktree")
    expect(list).toContain("isolated git worktree")
  })

  test("buildCardList reports none when nothing is available", () => {
    expect(buildCardList([])).toContain("No deferred tools")
  })
})
