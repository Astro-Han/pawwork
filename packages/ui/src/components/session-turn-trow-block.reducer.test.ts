import { expect, test, describe } from "bun:test"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import type { UiI18n } from "../context/i18n"
import {
  activeTrowTool,
  reduceTrowBlock,
  trowPartHasExpandableBody,
  trowBlockAnchor,
  toolFamilyIcon,
} from "./session-turn-trow-block"
import { buildToolInfo } from "./tool-info"

function tool(
  id: string,
  name: string,
  status: ToolState["status"] = "completed",
  options: { input?: Record<string, unknown>; output?: string; metadata?: Record<string, unknown> } = {},
): ToolPart {
  const input = options.input ?? {}
  const metadata = options.metadata ?? {}
  let state: ToolState
  switch (status) {
    case "pending":
      state = { status: "pending", input, raw: "" }
      break
    case "running":
      state = { status: "running", input, time: { start: 0 } }
      break
    case "error":
      state = { status: "error", input, error: "boom", time: { start: 0, end: 1 } }
      break
    case "completed":
    default:
      state = { status: "completed", input, output: options.output ?? "", title: "", metadata, time: { start: 0, end: 1 } }
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
  test("maps the well-known tool families to their shared toolIcon", () => {
    // `toolFamilyIcon` delegates to `toolIcon` (tool-info.ts), the single
    // source of truth. Pin the icon for every known family so an accidental
    // edit to `toolIcon` is caught here.
    expect(toolFamilyIcon("read")).toBe("read-file")
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
    expect(toolFamilyIcon("edit")).toBe("edit")
    expect(toolFamilyIcon("write")).toBe("edit")
    expect(toolFamilyIcon("apply_patch")).toBe("edit")
    expect(toolFamilyIcon("todowrite")).toBe("checklist")
    expect(toolFamilyIcon("question")).toBe("bubble-5")
    expect(toolFamilyIcon("skill")).toBe("skill")
  })

  test("unknown tool name falls back to the generic mcp icon", () => {
    expect(toolFamilyIcon("definitely-not-a-tool")).toBe("mcp")
    expect(toolFamilyIcon("")).toBe("mcp")
  })

  test("stays in lock-step with the expanded tool-info icon", () => {
    // The collapsed trow leading icon and the expanded tool header both flow
    // through `toolIcon`, so they must resolve to the same icon for every
    // family. This guards the two surfaces against drifting apart again.
    const i18n = { t: (k: string) => k, language: () => "en" } as unknown as UiI18n
    const families = [
      "read",
      "list",
      "glob",
      "grep",
      "webfetch",
      "websearch",
      "enter-worktree",
      "exit-worktree",
      "task",
      "agent",
      "bash",
      "edit",
      "write",
      "apply_patch",
      "todowrite",
      "question",
      "skill",
      "definitely-not-a-tool",
    ]
    for (const name of families) {
      expect(toolFamilyIcon(name)).toBe(buildToolInfo(tool("x", name), i18n).icon)
    }
  })
})

describe("reduceTrowBlock", () => {
  test("empty parts list yields a safe default (toolCount 0, mcp icon)", () => {
    const summary = reduceTrowBlock([])
    expect(summary).toEqual({ toolCount: 0, running: false, failedCount: 0, leadingIcon: "mcp" })
  })

  test("toolCount reflects the number of tools in the block", () => {
    const summary = reduceTrowBlock([tool("a", "bash"), tool("b", "bash"), tool("c", "edit")])
    expect(summary.toolCount).toBe(3)
  })

  test("running flag is true when any part is still running", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "running"),
      tool("c", "bash", "completed"),
    ])
    expect(summary.running).toBe(true)
  })

  test("pending tools count as live state", () => {
    const summary = reduceTrowBlock([
      tool("a", "bash", "completed"),
      tool("b", "bash", "pending"),
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
    expect(reduceTrowBlock([tool("a", "edit"), tool("b", "bash")]).leadingIcon).toBe("edit")
    expect(reduceTrowBlock([tool("a", "read")]).leadingIcon).toBe("read-file")
  })
})

describe("activeTrowTool", () => {
  test("returns the last live tool, not the first one", () => {
    const parts = [
      tool("a", "read", "completed"),
      tool("b", "bash", "running"),
      tool("c", "glob", "pending"),
    ]

    expect(activeTrowTool(parts)?.id).toBe("c")
  })

  test("keeps the last tool visible while the assistant round is still working", () => {
    const parts = [
      tool("a", "read", "completed"),
      tool("b", "bash", "completed"),
    ]

    expect(activeTrowTool(parts, true)?.id).toBe("b")
    expect(activeTrowTool(parts, false)).toBeUndefined()
  })
})

describe("trowPartHasExpandableBody", () => {
  test("keeps the chevron for live tools so running details can be opened", () => {
    expect(trowPartHasExpandableBody(tool("running", "bash", "running"))).toBe(true)
    expect(trowPartHasExpandableBody(tool("pending", "grep", "pending"))).toBe(true)
  })

  test("keeps the chevron for completed output and errors", () => {
    expect(trowPartHasExpandableBody(tool("output", "bash", "completed", { output: "done" }))).toBe(true)
    expect(trowPartHasExpandableBody(tool("error", "bash", "error"))).toBe(true)
  })

  test("keeps the chevron for completed question answers without output", () => {
    expect(
      trowPartHasExpandableBody(
        tool(
          "question",
          "question",
          "completed",
          {
            input: { questions: [{ question: "Continue?" }] },
            metadata: { answers: [["Yes"]] },
          },
        ),
      ),
    ).toBe(true)
  })

  test("keeps the chevron for completed dismissed questions without output", () => {
    expect(
      trowPartHasExpandableBody(
        tool("question", "question", "completed", {
          metadata: { dismissed: true },
        }),
      ),
    ).toBe(true)
  })

  test("keeps the chevron for completed edit details without output", () => {
    expect(
      trowPartHasExpandableBody(
        tool("edit", "edit", "completed", {
          input: { filePath: "/tmp/example.txt", oldString: "before", newString: "after" },
        }),
      ),
    ).toBe(true)
  })

  test("keeps the chevron for completed write content without output", () => {
    expect(
      trowPartHasExpandableBody(
        tool("write", "write", "completed", {
          input: { filePath: "/tmp/example.txt", content: "hello" },
        }),
      ),
    ).toBe(true)
  })

  test("keeps the chevron for completed apply_patch files without output", () => {
    expect(
      trowPartHasExpandableBody(
        tool("patch", "apply_patch", "completed", {
          metadata: {
            files: [
              {
                filePath: "/tmp/example.txt",
                relativePath: "example.txt",
                type: "add",
                before: "",
                after: "hello",
                additions: 1,
                deletions: 0,
              },
            ],
          },
        }),
      ),
    ).toBe(true)
  })

  test("does not add a chevron for completed tools with no visible body", () => {
    expect(trowPartHasExpandableBody(tool("empty", "skill", "completed"))).toBe(false)
  })
})

describe("trowBlockAnchor", () => {
  test("keeps the same anchor while a single tool grows into a trow group", () => {
    const first = tool("a", "bash")

    expect(trowBlockAnchor([first])).toBe(trowBlockAnchor([first, tool("b", "grep")]))
  })
})
