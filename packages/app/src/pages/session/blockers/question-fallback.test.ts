import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolState } from "@opencode-ai/sdk/v2"
import { findRunningQuestionFallbackSession } from "./question-fallback"

const message = (id: string): Message => ({ id }) as Message

const toolState = (status: ToolState["status"]): ToolState =>
  ({
    status,
    input: {},
    title: "",
    metadata: {},
    time: { start: 0 },
  }) as ToolState

const toolPart = (tool: string, status: ToolState["status"] = "running"): Part =>
  ({
    id: `part-${tool}-${status}`,
    type: "tool",
    tool,
    state: toolState(status),
  }) as Part

describe("findRunningQuestionFallbackSession", () => {
  test("returns undefined without a session", () => {
    expect(findRunningQuestionFallbackSession({ hasQuestionRequest: false, partsByMessageID: {} })).toBeUndefined()
  })

  test("returns undefined when a question request already exists", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        hasQuestionRequest: true,
        messages: [message("m")],
        partsByMessageID: { m: [toolPart("question")] },
      }),
    ).toBeUndefined()
  })

  test("returns the session when a recent running question tool part exists", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        hasQuestionRequest: false,
        messages: [message("m")],
        partsByMessageID: { m: [toolPart("question")] },
      }),
    ).toBe("s")
  })

  test("ignores non-running question parts and other tools", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        hasQuestionRequest: false,
        messages: [message("m1"), message("m2")],
        partsByMessageID: { m1: [toolPart("question", "completed")], m2: [toolPart("todowrite", "running")] },
      }),
    ).toBeUndefined()
  })

  test("recovers running question parts even when they are older than the lookback window", () => {
    expect(
      findRunningQuestionFallbackSession({
        sessionID: "s",
        hasQuestionRequest: false,
        messages: [message("old"), message("recent-1"), message("recent-2")],
        partsByMessageID: { old: [toolPart("question")] },
      }),
    ).toBe("s")
  })
})
