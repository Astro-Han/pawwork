import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"

const completed = (tool: string, input: Record<string, unknown>, title?: string, output?: string): ToolPart =>
  ({
    id: `part_${tool}`,
    sessionID: "ses_test",
    messageID: "msg_test",
    type: "tool",
    callID: `call_${tool}`,
    tool,
    state: {
      status: "completed",
      input,
      output: output ?? "",
      title,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as ToolPart

describe("cli run tool rendering", () => {
  test("keeps specialized bash rendering", async () => {
    const mod = await import("../../src/cli/cmd/run")
    expect(typeof mod.describeToolPartForRun).toBe("function")

    const result = mod.describeToolPartForRun(completed("bash", { command: "ls -la" }, undefined, "file.txt"))
    expect(result).toMatchObject({
      kind: "block",
      icon: "$",
      title: "ls -la",
      output: "file.txt",
    })
  })

  test("falls back for retired list tool parts", async () => {
    const mod = await import("../../src/cli/cmd/run")
    expect(typeof mod.describeToolPartForRun).toBe("function")

    const result = mod.describeToolPartForRun(
      completed("list", { path: "/tmp/project" }, "Legacy list title", "ignored output"),
    )
    expect(result).toMatchObject({
      kind: "inline",
      icon: "⚙",
      title: "list Legacy list title",
    })
  })
})
