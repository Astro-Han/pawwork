import { describe, expect, test } from "bun:test"

import { commandPolicyFailures, extractCommandsFromJsonl } from "./eval"

describe("office route eval harness", () => {
  test("extracts shell commands from opencode json events", () => {
    const jsonl = [
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "officecli create artifacts/out.xlsx", description: "create workbook" },
          },
        },
      }),
      JSON.stringify({ type: "text", part: { text: "done" } }),
    ].join("\n")

    const audit = extractCommandsFromJsonl(jsonl)
    expect(audit.commands).toEqual([
      {
        tool: "bash",
        command: "officecli create artifacts/out.xlsx",
        description: "create workbook",
        status: "completed",
      },
    ])
    expect(audit.eventCounts.tool_use).toBe(1)
  })

  test("enforces python route tool boundary", () => {
    expect(commandPolicyFailures("python", [{ tool: "bash", command: "uv run python build.py" }])).toEqual([])
    expect(commandPolicyFailures("python", [{ tool: "bash", command: "officecli create out.xlsx" }])).toContain(
      "Python route did not call uv.",
    )
  })

  test("enforces officecli route tool boundary", () => {
    expect(commandPolicyFailures("officecli", [{ tool: "bash", command: "officecli create out.docx" }])).toEqual([])
    expect(commandPolicyFailures("officecli", [{ tool: "bash", command: "uv run python build.py" }])).toContain(
      "OfficeCLI route did not call officecli.",
    )
  })
})
