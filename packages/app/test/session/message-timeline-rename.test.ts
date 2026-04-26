import { describe, expect, test } from "bun:test"
import { taskDescription } from "@/pages/session/task-description"
import type { ToolPart } from "@opencode-ai/sdk/v2"

const sessionID = "session-123"

const baseFields = {
  id: "part-1",
  sessionID,
  messageID: "msg-1",
  callID: "call-1",
  type: "tool" as const,
  state: {
    status: "completed" as const,
    input: { description: "explore" },
    output: "ok",
    metadata: { sessionId: sessionID },
    time: { start: 1, end: 2 },
  },
}

const partTask: ToolPart = { ...baseFields, tool: "task" } // agent-rename:legacy-render
const partAgent: ToolPart = { ...baseFields, tool: "agent" }
const partOther: ToolPart = { ...baseFields, tool: "bash" }

describe("message-timeline taskDescription dual match (#128)", () => {
  test("returns description for tool: 'task'", () => { // agent-rename:legacy-render
    expect(taskDescription(partTask, sessionID)).toBe("explore")
  })

  test("returns description for tool: 'agent'", () => {
    expect(taskDescription(partAgent, sessionID)).toBe("explore")
  })

  test("returns undefined for non-task/agent tools", () => {
    expect(taskDescription(partOther, sessionID)).toBeUndefined()
  })
})
