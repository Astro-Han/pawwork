import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  buildActivationReminder,
  buildCardList,
  DEFERRED_TOOL_IDS,
  deriveActivatedTools,
  deriveNewlyActivated,
  makeToolInfoTool,
} from "../../src/tool/tool-info"
import type { MessageV2 } from "../../src/session/message-v2"

function toolPart(
  tool: string,
  status: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
) {
  return { type: "tool", tool, callID: "c", state: { status, input, ...(metadata ? { metadata } : {}) } }
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

  test("tool_info refuses a deferred tool hidden this turn", async () => {
    const tool = makeToolInfoTool({
      lookup: (id) => (id === "enter-worktree" ? { description: "desc", parameters: Schema.Struct({}) } : undefined),
    })
    const ctx = { extra: { deferredAvailable: () => false } } as unknown as Parameters<typeof tool.execute>[1]
    const exit = await Effect.runPromiseExit(tool.execute({ name: "enter-worktree" }, ctx))
    expect(exit._tag).toBe("Failure")
  })

  test("tool_info loads an available deferred tool and marks it activated", async () => {
    const tool = makeToolInfoTool({
      lookup: (id) => (id === "enter-worktree" ? { description: "desc", parameters: Schema.Struct({}) } : undefined),
    })
    const ctx = { extra: { deferredAvailable: () => true } } as unknown as Parameters<typeof tool.execute>[1]
    const result = await Effect.runPromise(tool.execute({ name: "enter-worktree" }, ctx))
    expect(result.output).toContain("is now in your tool list")
    expect(result.metadata).toMatchObject({ activated: "enter-worktree" })
  })

  test("deriveNewlyActivated only picks the most recent assistant message", () => {
    const messages = [
      assistant([toolPart("tool_info", "completed", { name: "enter-worktree" }, { activated: "enter-worktree" })]),
      { info: { role: "user" }, parts: [] } as unknown as MessageV2.WithParts,
      assistant([toolPart("tool_info", "completed", { name: "exit-worktree" }, { activated: "exit-worktree" })]),
    ]
    expect([...deriveNewlyActivated(messages)]).toEqual(["exit-worktree"])
  })

  test("deriveNewlyActivated returns empty when the last assistant has no tool_info part", () => {
    const messages = [assistant([toolPart("read", "completed", {})])]
    expect(deriveNewlyActivated(messages).size).toBe(0)
  })

  test("buildActivationReminder anchors on system-reminder and rules out the bash fallback for enter-worktree", () => {
    const r = buildActivationReminder("enter-worktree")
    expect(r).toContain("<system-reminder>")
    expect(r).toContain("</system-reminder>")
    expect(r).toContain("enter-worktree")
    expect(r).toContain("bash git worktree")
  })

  test("buildActivationReminder omits the anti-fallback hint for tools that have none", () => {
    const r = buildActivationReminder("exit-worktree")
    expect(r).toContain("exit-worktree")
    expect(r).not.toContain("bash git worktree")
  })
})
