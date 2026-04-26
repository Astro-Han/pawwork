import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { buildToolInfo } from "../../src/components/tool-info"
import type { UiI18n } from "../../src/context/i18n"

const baseFields = {
  id: "part-1",
  sessionID: "session-1",
  messageID: "msg-1",
  callID: "call-1",
  type: "tool" as const,
  state: {
    status: "completed" as const,
    title: "explore",
    input: { description: "explore components", subagent_type: "explore" },
    output: "Found 12 components.",
    metadata: { sessionId: "sub-session-1" },
    time: { start: 1, end: 2 },
  },
}

const partTask = { ...baseFields, tool: "task" } as ToolPart // agent-rename:legacy-render
const partAgent = { ...baseFields, tool: "agent" } as ToolPart

const i18n = { t: (k: string) => k, language: () => "en" } as unknown as UiI18n

describe("message-part dual render (#128)", () => {
  test("derived tool-info icon is 'agent' for both inputs", () => {
    expect(buildToolInfo(partTask, i18n).icon).toBe("agent")
    expect(buildToolInfo(partAgent, i18n).icon).toBe("agent")
  })

  test("derived tool-info title is identical between task and agent inputs", () => {
    expect(buildToolInfo(partTask, i18n).title).toEqual(buildToolInfo(partAgent, i18n).title)
  })

  test("derived tool-info subtitle is identical between task and agent inputs", () => {
    expect(buildToolInfo(partTask, i18n).subtitle).toEqual(buildToolInfo(partAgent, i18n).subtitle)
  })
})
