import { describe, expect, test } from "bun:test"
import type { Message, Part, ToolState } from "@opencode-ai/sdk/v2"
import { findRunningExternalResultQuestion } from "./running-external-result-question"

const message = (id: string): Message => ({ id }) as Message

const toolState = (
  status: ToolState["status"],
  metadata?: Record<string, unknown>,
  input?: Record<string, unknown>,
): ToolState =>
  ({
    status,
    input: input ?? {},
    title: "",
    metadata: metadata ?? {},
    time: { start: 0 },
  }) as ToolState

const toolPart = (
  id: string,
  tool: string,
  state: ToolState,
  attrs?: { messageID?: string; callID?: string },
): Part =>
  ({
    id,
    type: "tool",
    tool,
    state,
    messageID: attrs?.messageID ?? "m1",
    callID: attrs?.callID ?? "c1",
  }) as Part

const questions = [{ header: "h", question: "q", options: [] }]

describe("findRunningExternalResultQuestion", () => {
  test("returns undefined when there are no messages", () => {
    expect(
      findRunningExternalResultQuestion({
        sessionID: "s",
        messages: undefined,
        partsByMessageID: {},
      }),
    ).toBeUndefined()
  })

  test("returns undefined when the running question part has no externalResultReady metadata (preparing window)", () => {
    expect(
      findRunningExternalResultQuestion({
        sessionID: "s",
        messages: [message("m1")],
        partsByMessageID: {
          m1: [toolPart("p1", "question", toolState("running", { externalResultReady: false }, { questions }))],
        },
      }),
    ).toBeUndefined()
  })

  test("returns the part identity when externalResultReady === true", () => {
    const result = findRunningExternalResultQuestion({
      sessionID: "s",
      messages: [message("m1")],
      partsByMessageID: {
        m1: [
          toolPart(
            "p1",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m1", callID: "c1" },
          ),
        ],
      },
    })
    expect(result).toEqual({
      id: "m1:c1",
      sessionID: "s",
      questions,
      messageID: "m1",
      callID: "c1",
    })
  })

  test("ignores completed dismissed parts (terminal state belongs to the timeline, not the dock)", () => {
    expect(
      findRunningExternalResultQuestion({
        sessionID: "s",
        messages: [message("m1")],
        partsByMessageID: {
          m1: [
            toolPart(
              "p1",
              "question",
              toolState("completed", { externalResultReady: true, dismissed: true }, { questions }),
            ),
          ],
        },
      }),
    ).toBeUndefined()
  })

  test("returns the first running ready part in message order", () => {
    const result = findRunningExternalResultQuestion({
      sessionID: "s",
      messages: [message("m1"), message("m2")],
      partsByMessageID: {
        m1: [
          toolPart(
            "p1",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m1", callID: "c-first" },
          ),
        ],
        m2: [
          toolPart(
            "p2",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m2", callID: "c-second" },
          ),
        ],
      },
    })
    expect(result?.callID).toBe("c-first")
  })
})
