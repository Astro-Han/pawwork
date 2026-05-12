import { expect, test, describe } from "bun:test"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import {
  reduceTrowBlock,
  toolFamilyIcon,
  trowSummaryI18nKey,
} from "./session-turn-trow-block"

function tool(id: string, name: string, status: ToolState["status"] = "completed"): ToolPart {
  let state: ToolState
  switch (status) {
    case "pending":
      state = { status: "pending", input: {}, raw: "" }
      break
    case "running":
      state = { status: "running", input: {}, time: { start: 0 } }
      break
    case "error":
      state = { status: "error", input: {}, error: "boom", time: { start: 0, end: 1 } }
      break
    case "completed":
    default:
      state = { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } }
  }
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: `call-${id}`,
    tool: name,
    state,
  }
}

describe("toolFamilyIcon", () => {
  test("maps the well-known tool families to their getToolInfo icons", () => {
    // Pin the contract for every tool family `getToolInfo` knows. Updating
    // `getToolInfo` without updating `toolFamilyIcon` causes the trow-block
    // leading icon to drift from the trow body's tool-info icon.
    expect(toolFamilyIcon("read")).toBe("glasses")
    expect(toolFamilyIcon("list")).toBe("bullet-list")
    expect(toolFamilyIcon("glob")).toBe("magnifying-glass-menu")
    expect(toolFamilyIcon("grep")).toBe("magnifying-glass-menu")
    expect(toolFamilyIcon("webfetch")).toBe("window-cursor")
    expect(toolFamilyIcon("websearch")).toBe("window-cursor")
    expect(toolFamilyIcon("enter-worktree")).toBe("worktree")
    expect(toolFamilyIcon("exit-worktree")).toBe("worktree")
    expect(toolFamilyIcon("task")).toBe("agent")
    expect(toolFamilyIcon("agent")).toBe("agent")
    expect(toolFamilyIcon("bash")).toBe("console")
    expect(toolFamilyIcon("edit")).toBe("code-lines")
    expect(toolFamilyIcon("write")).toBe("code-lines")
    expect(toolFamilyIcon("apply_patch")).toBe("code-lines")
    expect(toolFamilyIcon("todowrite")).toBe("checklist")
    expect(toolFamilyIcon("question")).toBe("bubble-5")
    expect(toolFamilyIcon("skill")).toBe("brain")
  })

  test("unknown tool name falls back to the generic mcp icon", () => {
    expect(toolFamilyIcon("definitely-not-a-tool")).toBe("mcp")
    expect(toolFamilyIcon("")).toBe("mcp")
  })
})

describe("reduceTrowBlock", () => {
  test("empty parts list yields a safe default (count 0, mcp icon)", () => {
    const summary = reduceTrowBlock([])
    expect(summary).toEqual({ count: 0, running: false, failedCount: 0, leadingIcon: "mcp" })
  })

  test("count reflects the number of tools in the block", () => {
    const summary = reduceTrowBlock([tool("a", "bash"), tool("b", "bash"), tool("c", "edit")])
    expect(summary.count).toBe(3)
  })

  test("running flag is true when any part is still running", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "running"),
      tool("c", "bash", "completed"),
    ])
    expect(summary.running).toBe(true)
  })

  test("running flag is false once every part has completed or errored", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "error"),
      tool("c", "bash", "completed"),
    ])
    expect(summary.running).toBe(false)
  })

  test("failedCount counts error-status parts", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "error"),
      tool("c", "bash", "error"),
    ])
    expect(summary.failedCount).toBe(2)
  })

  test("leadingIcon is resolved from the first tool's family", () => {
    expect(reduceTrowBlock([tool("a", "bash"), tool("b", "edit")]).leadingIcon).toBe("console")
    expect(reduceTrowBlock([tool("a", "edit"), tool("b", "bash")]).leadingIcon).toBe("code-lines")
    expect(reduceTrowBlock([tool("a", "read")]).leadingIcon).toBe("glasses")
  })
})

describe("trowSummaryI18nKey", () => {
  test("running summary takes precedence over failure (live state wins)", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "error"),
      tool("b", "bash", "running"),
    ])
    expect(trowSummaryI18nKey(summary)).toBe("session.trow.summary.running")
  })

  test("completed-with-failures summary surfaces the failure count", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "error"),
    ])
    expect(trowSummaryI18nKey(summary)).toBe("session.trow.summary.withFailed")
  })

  test("plain completed summary when no errors and no running parts", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "completed"),
    ])
    expect(trowSummaryI18nKey(summary)).toBe("session.trow.summary.completed")
  })
})
