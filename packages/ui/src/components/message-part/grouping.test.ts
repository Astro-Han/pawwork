import { expect, test, describe } from "bun:test"
import type { Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { groupParts, renderable } from "./grouping"

function textPart(id: string, text: string): TextPart {
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "text",
    text,
  }
}

function toolPart(id: string, tool: string, status: "pending" | "running" | "completed" | "error" = "completed"): ToolPart {
  if (status === "pending") {
    return {
      id,
      sessionID: "s",
      messageID: "m",
      type: "tool",
      callID: `call-${id}`,
      tool,
      state: { status: "pending", input: {}, raw: "" },
    }
  }
  if (status === "running") {
    return {
      id,
      sessionID: "s",
      messageID: "m",
      type: "tool",
      callID: `call-${id}`,
      tool,
      state: { status: "running", input: {}, time: { start: 0 } },
    }
  }
  if (status === "error") {
    return {
      id,
      sessionID: "s",
      messageID: "m",
      type: "tool",
      callID: `call-${id}`,
      tool,
      state: { status: "error", input: {}, error: "fail", time: { start: 0, end: 1 } },
    }
  }
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: `call-${id}`,
    tool,
    state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 0, end: 1 } },
  }
}

function groupRenderable(parts: Part[]) {
  return groupParts(
    parts
      .filter((part) => renderable(part))
      .map((part) => ({
        messageID: part.messageID,
        part,
      })),
  )
}

describe("message-part groupParts", () => {
  test("a single renderable tool stays as a normal part", () => {
    const result = groupRenderable([toolPart("a", "bash")])

    expect(result).toEqual([
      {
        key: "part:m:a",
        type: "part",
        ref: { messageID: "m", partID: "a" },
      },
    ])
  })

  test("tool-only input emits one trow group", () => {
    const result = groupRenderable([toolPart("a", "bash"), toolPart("b", "bash"), toolPart("c", "edit")])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      key: "trow:a",
      type: "trow",
      refs: [
        { messageID: "m", partID: "a" },
        { messageID: "m", partID: "b" },
        { messageID: "m", partID: "c" },
      ],
    })
  })

  test("text between tool runs flushes into separate trows", () => {
    const result = groupRenderable([
      toolPart("t1", "bash"),
      toolPart("t2", "bash"),
      textPart("p1", "intermediate prose"),
      toolPart("t3", "edit"),
    ])

    expect(result.map((group) => group.type)).toEqual(["trow", "part", "part"])
    expect(result[1]).toEqual({
      key: "part:m:p1",
      type: "part",
      ref: { messageID: "m", partID: "p1" },
    })
    expect(result[2]).toEqual({
      key: "part:m:t3",
      type: "part",
      ref: { messageID: "m", partID: "t3" },
    })
  })

  test("hidden tools are filtered before grouping and do not split a trow", () => {
    const result = groupRenderable([toolPart("t1", "bash"), toolPart("h1", "todowrite"), toolPart("t2", "bash")])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      key: "trow:t1",
      type: "trow",
      refs: [
        { messageID: "m", partID: "t1" },
        { messageID: "m", partID: "t2" },
      ],
    })
  })

  test("pending question tools are filtered before grouping", () => {
    const result = groupRenderable([toolPart("t1", "bash"), toolPart("q1", "question", "pending"), toolPart("t2", "bash")])

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("trow")
  })
})
