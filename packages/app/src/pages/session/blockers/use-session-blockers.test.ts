import { describe, expect, test } from "bun:test"
import type { Message, Part, Session, ToolState } from "@opencode-ai/sdk/v2"
import {
  findDescendantExternalResultQuestion,
  findRunningExternalResultQuestion,
} from "./running-external-result-question"

const message = (id: string): Message => ({ id }) as Message

const session = (id: string, parentID?: string): Session => ({ id, parentID }) as Session

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

  test("returns undefined when externalResultReady is explicitly false (preparing window)", () => {
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

  test("returns undefined when externalResultReady metadata key is missing", () => {
    expect(
      findRunningExternalResultQuestion({
        sessionID: "s",
        messages: [message("m1")],
        partsByMessageID: {
          m1: [toolPart("p1", "question", toolState("running", {}, { questions }))],
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

describe("findDescendantExternalResultQuestion", () => {
  test("returns the request from the active session when present", () => {
    const result = findDescendantExternalResultQuestion({
      sessions: [session("parent"), session("child", "parent")],
      rootSessionID: "parent",
      messages: {
        parent: [message("m1")],
        child: [message("m2")],
      },
      partsByMessageID: {
        m1: [
          toolPart(
            "p1",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m1", callID: "c-parent" },
          ),
        ],
        m2: [
          toolPart(
            "p2",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m2", callID: "c-child" },
          ),
        ],
      },
    })
    expect(result?.sessionID).toBe("parent")
    expect(result?.callID).toBe("c-parent")
  })

  test("falls back to a child session question when the active session has none", () => {
    const result = findDescendantExternalResultQuestion({
      sessions: [session("parent"), session("child", "parent")],
      rootSessionID: "parent",
      messages: {
        parent: [message("m1")],
        child: [message("m2")],
      },
      partsByMessageID: {
        m1: [],
        m2: [
          toolPart(
            "p2",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m2", callID: "c-child" },
          ),
        ],
      },
    })
    expect(result?.sessionID).toBe("child")
    expect(result?.callID).toBe("c-child")
  })

  test("returns undefined when neither session has a running question", () => {
    expect(
      findDescendantExternalResultQuestion({
        sessions: [session("parent"), session("child", "parent")],
        rootSessionID: "parent",
        messages: { parent: [message("m1")], child: [message("m2")] },
        partsByMessageID: {
          m1: [toolPart("p1", "bash", toolState("running"))],
          m2: [toolPart("p2", "bash", toolState("running"))],
        },
      }),
    ).toBeUndefined()
  })

  test("walks grandchildren transitively", () => {
    const result = findDescendantExternalResultQuestion({
      sessions: [
        session("root"),
        session("child", "root"),
        session("grand", "child"),
      ],
      rootSessionID: "root",
      messages: { grand: [message("m3")] },
      partsByMessageID: {
        m3: [
          toolPart(
            "p3",
            "question",
            toolState("running", { externalResultReady: true }, { questions }),
            { messageID: "m3", callID: "c-grand" },
          ),
        ],
      },
    })
    expect(result?.sessionID).toBe("grand")
  })
})
