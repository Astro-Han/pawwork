import { describe, expect, test } from "bun:test"
import { PRUNE_PROTECTED_TOOLS } from "../../src/session/compaction"
import {
  buildActivationReminder,
  buildCardList,
  buildDeferredHint,
  canonicalDeferredId,
  DEFERRED_TOOL_IDS,
  deriveActivatedTools,
  deriveNewlyActivated,
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
  test("DEFERRED_TOOL_IDS is exactly the worktree tools plus lsp", () => {
    expect([...DEFERRED_TOOL_IDS].sort()).toEqual(["enter-worktree", "exit-worktree", "lsp"])
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

  test("deriveActivatedTools canonicalises a CamelCase echo so the recorded raw input still activates", () => {
    const messages = [
      assistant([toolPart("tool_info", "completed", { name: "Enter-Worktree" }, { activated: "enter-worktree" })]),
    ]
    expect([...deriveActivatedTools(messages)]).toEqual(["enter-worktree"])
  })

  test("buildCardList lists available deferred tools with their cards", () => {
    const list = buildCardList(["enter-worktree", "exit-worktree", "lsp"])
    expect(list).not.toContain("automate")
    expect(list).toContain("enter-worktree")
    expect(list).toContain("exit-worktree")
    expect(list).toContain("lsp")
    expect(list).toContain("isolated git worktree")
  })

  test("buildCardList reports none when nothing is available", () => {
    expect(buildCardList([])).toContain("No deferred tools")
  })

  test("deriveNewlyActivated reports the activation on the given assistant turn", () => {
    const turn = assistant([
      toolPart("tool_info", "completed", { name: "exit-worktree" }, { activated: "exit-worktree" }),
    ])
    expect([...deriveNewlyActivated(turn)]).toEqual(["exit-worktree"])
  })

  test("deriveNewlyActivated returns empty when the assistant turn has no tool_info part", () => {
    expect(deriveNewlyActivated(assistant([toolPart("read", "completed", {})])).size).toBe(0)
  })

  test("deriveNewlyActivated returns empty when there is no assistant turn", () => {
    expect(deriveNewlyActivated(undefined).size).toBe(0)
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

  test("buildDeferredHint canonicalises a CamelCase model echo to the real kebab-case id", () => {
    const hint = buildDeferredHint("Enter-Worktree")
    expect(hint).toContain(`name="enter-worktree"`)
    expect(hint).not.toContain(`name="Enter-Worktree"`)
  })

  test("buildDeferredHint passes a canonical kebab-case id through unchanged", () => {
    const hint = buildDeferredHint("enter-worktree")
    expect(hint).toContain(`name="enter-worktree"`)
  })

  test("buildDeferredHint returns empty string for non-deferred tools", () => {
    expect(buildDeferredHint("read")).toBe("")
    expect(buildDeferredHint("Bash")).toBe("")
  })

  test("buildDeferredHint stays silent when the deferred tool is unavailable", () => {
    expect(buildDeferredHint("enter-worktree", () => false)).toBe("")
    expect(buildDeferredHint("enter-worktree", () => true)).toContain(`name="enter-worktree"`)
  })

  test("canonicalDeferredId maps mis-cased echoes to the real id and rejects non-deferred names", () => {
    expect(canonicalDeferredId("enter-worktree")).toBe("enter-worktree")
    expect(canonicalDeferredId("Enter-Worktree")).toBe("enter-worktree")
    expect(canonicalDeferredId("ENTER-WORKTREE")).toBe("enter-worktree")
    expect(canonicalDeferredId("Automate")).toBeUndefined()
    expect(canonicalDeferredId("LSP")).toBe("lsp")
    expect(canonicalDeferredId("read")).toBeUndefined()
  })

  test("compaction PRUNE_PROTECTED_TOOLS protects tool_info so activation survives pruning", () => {
    expect(PRUNE_PROTECTED_TOOLS).toContain("tool_info")
  })
})
