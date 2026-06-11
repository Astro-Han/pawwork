import { describe, expect, test } from "bun:test"
import { PRUNE_PROTECTED_TOOLS } from "../../src/session/compaction"
import {
  buildActivationReminder,
  buildCardList,
  buildDeferredHint,
  canonicalActivationTarget,
  canonicalDeferredId,
  DEFERRED_GROUP_IDS,
  DEFERRED_TOOL_IDS,
  deferredGroupMembers,
  deriveActivatedTools,
  deriveNewlyActivated,
} from "../../src/tool/tool-info"
import type { MessageV2 } from "../../src/session/message-v2"

const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_wait",
  "browser_screenshot",
  "browser_extract",
]
const OPENCLI_TOOLS = ["opencli_search", "opencli_run"]

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
  test("DEFERRED_TOOL_IDS is exactly the worktree tools plus lsp plus the browser and opencli groups", () => {
    expect([...DEFERRED_TOOL_IDS].sort()).toEqual(
      [...BROWSER_TOOLS, ...OPENCLI_TOOLS, "enter-worktree", "exit-worktree", "lsp"].sort(),
    )
    expect([...DEFERRED_GROUP_IDS].sort()).toEqual(["browser", "opencli"].sort())
    expect(deferredGroupMembers("browser").sort()).toEqual([...BROWSER_TOOLS].sort())
    expect(deferredGroupMembers("opencli").sort()).toEqual([...OPENCLI_TOOLS].sort())
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
    expect([...deriveNewlyActivated(turn)]).toEqual([["exit-worktree", undefined]])
  })

  test("deriveNewlyActivated carries the availability-filtered members a group activation recorded", () => {
    const members = ["browser_navigate", "browser_snapshot"]
    const turn = assistant([toolPart("tool_info", "completed", { name: "browser" }, { activated: "browser", members })])
    expect([...deriveNewlyActivated(turn)]).toEqual([["browser", members]])
  })

  test("buildActivationReminder lists only the members the activation actually rendered", () => {
    const r = buildActivationReminder("browser", ["browser_navigate", "browser_snapshot"])
    expect(r).toContain("browser_navigate, browser_snapshot")
    expect(r).not.toContain("browser_screenshot")
    // Without a recorded list (older parts), fall back to the full roster.
    expect(buildActivationReminder("browser")).toContain("browser_screenshot")
  })

  test("buildActivationReminder re-filters recorded members through the current step's availability", () => {
    // The recorded list is a snapshot from the activating step; a session resumed
    // under different permissions must not be promised a now-hidden member.
    const recorded = ["browser_navigate", "browser_snapshot", "browser_screenshot"]
    const r = buildActivationReminder("browser", recorded, (id) => id !== "browser_screenshot")
    expect(r).toContain("browser_navigate, browser_snapshot")
    expect(r).not.toContain("browser_screenshot")
  })

  test("buildActivationReminder returns empty when nothing it would announce is exposable", () => {
    expect(buildActivationReminder("browser", ["browser_navigate"], () => false)).toBe("")
    expect(buildActivationReminder("enter-worktree", undefined, () => false)).toBe("")
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

  test("a group activation expands to every member id from durable history", () => {
    // Same derivation path the prompt loop runs over storage-fed parts, so the
    // expansion holds across compaction and restart (history is re-read each turn).
    const messages = [assistant([toolPart("tool_info", "completed", { name: "browser" }, { activated: "browser" })])]
    const activated = deriveActivatedTools(messages)
    for (const id of BROWSER_TOOLS) expect(activated.has(id)).toBe(true)
  })

  test("activating via a member name still activates the whole group", () => {
    const messages = [assistant([toolPart("tool_info", "completed", { name: "Browser_Click" })])]
    const activated = deriveActivatedTools(messages)
    for (const id of BROWSER_TOOLS) expect(activated.has(id)).toBe(true)
  })

  test("canonicalActivationTarget resolves groups, members, and standalone tools", () => {
    expect(canonicalActivationTarget("browser")).toEqual({ kind: "group", id: "browser" })
    expect(canonicalActivationTarget("BROWSER")).toEqual({ kind: "group", id: "browser" })
    expect(canonicalActivationTarget("browser_click")).toEqual({ kind: "group", id: "browser" })
    expect(canonicalActivationTarget("enter-worktree")).toEqual({ kind: "tool", id: "enter-worktree" })
    expect(canonicalActivationTarget("read")).toBeUndefined()
  })

  test("buildCardList collapses grouped tools into one browser card", () => {
    const list = buildCardList(["enter-worktree", ...BROWSER_TOOLS])
    expect(list).toContain("**browser** (tool group)")
    expect(list).toContain("enter-worktree")
    // member ids must not appear as separate cards
    expect(list).not.toContain("**browser_click**")
  })

  test("deriveNewlyActivated reports a group activation token", () => {
    const turn = assistant([toolPart("tool_info", "completed", { name: "browser" }, { activated: "browser" })])
    expect([...deriveNewlyActivated(turn)]).toEqual([["browser", undefined]])
  })

  test("buildActivationReminder for the group lists member tools and warns there is no `browser` tool", () => {
    const r = buildActivationReminder("browser")
    expect(r).toContain("<system-reminder>")
    for (const id of BROWSER_TOOLS) expect(r).toContain(id)
    expect(r).toContain("no tool named")
  })

  test("buildDeferredHint routes a direct browser_* call to the group activation", () => {
    const hint = buildDeferredHint("browser_click")
    expect(hint).toContain(`name="browser"`)
    expect(hint).toContain("browser_click")
    expect(hint).not.toContain(`name="browser_click"`)
  })

  test("buildDeferredHint stays silent when every group member is unavailable", () => {
    expect(buildDeferredHint("browser_click", () => false)).toBe("")
    expect(buildDeferredHint("browser_click", (id) => id === "browser_click")).toContain(`name="browser"`)
  })

  test("buildDeferredHint stays silent when the called member itself is unavailable", () => {
    // Other members being available is not enough: activating the group would
    // never expose the member the model actually called.
    expect(buildDeferredHint("browser_screenshot", (id) => id !== "browser_screenshot")).toBe("")
  })

  test("buildDeferredHint picks an available exemplar for a group-name call", () => {
    const hint = buildDeferredHint("browser", (id) => id === "browser_click")
    expect(hint).toContain(`name="browser"`)
    expect(hint).toContain("browser_click")
    expect(hint).not.toContain("browser_navigate")
  })
})
