import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"
import {
  TOOL_AGENT,
  TOOL_AGENT_LEGACY,
  TOOL_QUESTION,
  TOOL_TODOWRITE,
  TOOL_WEBFETCH,
  TOOL_WEBSEARCH,
} from "./tool-contract"

describe("tool contract names", () => {
  const OPENCODE_TOOL_DIR = join(import.meta.dirname, "../../../opencode/src/tool")
  const quoted = (value: string) => `["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`
  const toolDefinePattern = (tool: string) => new RegExp(`Tool\\.define(?:<[\\s\\S]*?>)?\\(\\s*${quoted(tool)}`)

  const cases: Array<[string, string, RegExp]> = [
    [TOOL_TODOWRITE, "todo.ts", toolDefinePattern(TOOL_TODOWRITE)],
    [TOOL_WEBFETCH, "webfetch.ts", toolDefinePattern(TOOL_WEBFETCH)],
    [TOOL_WEBSEARCH, "websearch.ts", toolDefinePattern(TOOL_WEBSEARCH)],
    [TOOL_QUESTION, "question.ts", toolDefinePattern(TOOL_QUESTION)],
    [TOOL_AGENT, "agent.ts", new RegExp(`const\\s+id\\s*=\\s*${quoted(TOOL_AGENT)}`)],
  ]

  for (const [tool, filename, pattern] of cases) {
    it(`keeps "${tool}" compatible with packages/opencode/src/tool/${filename}`, () => {
      const source = readFileSync(join(OPENCODE_TOOL_DIR, filename), "utf8")
      expect(source).toMatch(pattern)
    })
  }

  it("keeps the legacy agent tool name explicit", () => {
    expect(TOOL_AGENT_LEGACY).toBe("task")
  })
})
