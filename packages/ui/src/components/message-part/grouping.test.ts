import { expect, test, describe } from "bun:test"
import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { activeWorkingTrowKey, groupParts, partDefaultOpen, renderable } from "./grouping"

function textPart(id: string, text: string): TextPart {
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "text",
    text,
  }
}

function toolPart(
  id: string,
  tool: string,
  status: "pending" | "running" | "completed" | "error" = "completed",
  metadata?: Record<string, unknown>,
): ToolPart {
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
      state: { status: "running", input: {}, metadata, time: { start: 0 } },
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

function reasoningPart(id: string, text = "thinking through it"): ReasoningPart {
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "reasoning",
    text,
    time: { start: 0, end: 1 },
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
  test("a single renderable tool emits one direct trow group", () => {
    const result = groupRenderable([toolPart("a", "bash")])

    expect(result).toEqual([
      {
        key: "trow:a",
        type: "trow",
        refs: [{ messageID: "m", partID: "a" }],
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

    expect(result.map((group) => group.type)).toEqual(["trow", "part", "trow"])
    expect(result[1]).toEqual({
      key: "part:m:p1",
      type: "part",
      ref: { messageID: "m", partID: "p1" },
    })
    expect(result[2]).toEqual({
      key: "trow:t3",
      type: "trow",
      refs: [{ messageID: "m", partID: "t3" }],
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

  test("unready pending question tools are filtered before grouping", () => {
    const result = groupRenderable([toolPart("t1", "bash"), toolPart("q1", "question", "pending"), toolPart("t2", "bash")])

    expect(renderable(toolPart("q1", "question", "pending"))).toBe(false)
    expect(renderable(toolPart("q2", "question", "running", { externalResultReady: false }))).toBe(false)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("trow")
  })

  test("ready running question tools split into a visible single trow marker", () => {
    const result = groupRenderable([
      toolPart("t1", "bash"),
      toolPart("q1", "question", "running", { externalResultReady: true }),
    ])

    expect(renderable(toolPart("q1", "question", "running", { externalResultReady: true }))).toBe(true)
    expect(result).toEqual([
      {
        key: "trow:t1",
        type: "trow",
        refs: [{ messageID: "m", partID: "t1" }],
      },
      {
        key: "trow:q1",
        type: "trow",
        refs: [{ messageID: "m", partID: "q1" }],
      },
    ])
  })

  test("a reasoning part folds into a trow group, not a standalone part", () => {
    const result = groupRenderable([reasoningPart("r1")])

    expect(result).toEqual([
      {
        key: "trow:r1",
        type: "trow",
        refs: [{ messageID: "m", partID: "r1" }],
      },
    ])
  })

  test("reasoning and adjacent tools share one trow group", () => {
    const result = groupRenderable([reasoningPart("r1"), toolPart("t1", "bash"), toolPart("t2", "edit")])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      key: "trow:r1",
      type: "trow",
      refs: [
        { messageID: "m", partID: "r1" },
        { messageID: "m", partID: "t1" },
        { messageID: "m", partID: "t2" },
      ],
    })
  })

  test("empty reasoning is filtered before grouping", () => {
    const result = groupRenderable([reasoningPart("r1", "   "), toolPart("t1", "bash")])

    expect(result).toEqual([
      {
        key: "trow:t1",
        type: "trow",
        refs: [{ messageID: "m", partID: "t1" }],
      },
    ])
  })
})

describe("message-part activeWorkingTrowKey", () => {
  test("keeps the last visible trow active while the turn is working", () => {
    const result = groupRenderable([textPart("p1", "first"), toolPart("t1", "bash"), toolPart("t2", "grep")])

    expect(activeWorkingTrowKey(result, true)).toBe("trow:t1")
  })

  test("does not keep an earlier trow active after following text appears", () => {
    const result = groupRenderable([toolPart("t1", "bash"), toolPart("t2", "grep"), textPart("p1", "next prose")])

    expect(activeWorkingTrowKey(result, true)).toBeUndefined()
  })

  test("does not mark any trow active when the turn is idle", () => {
    const result = groupRenderable([toolPart("t1", "bash"), toolPart("t2", "grep")])

    expect(activeWorkingTrowKey(result, false)).toBeUndefined()
  })
})

describe("message-part partDefaultOpen", () => {
  test("respects shell and edit default-open settings for tool rows", () => {
    expect(partDefaultOpen(toolPart("bash-closed", "bash"), false, true)).toBe(false)
    expect(partDefaultOpen(toolPart("bash-open", "bash"), true, false)).toBe(true)

    expect(partDefaultOpen(toolPart("edit-closed", "edit"), true, false)).toBe(false)
    expect(partDefaultOpen(toolPart("edit-open", "edit"), false, true)).toBe(true)
    expect(partDefaultOpen(toolPart("write-open", "write"), false, true)).toBe(true)
    expect(partDefaultOpen(toolPart("patch-open", "apply_patch"), false, true)).toBe(true)
  })

  test("leaves non-configured tools to the caller fallback", () => {
    expect(partDefaultOpen(toolPart("read", "read"), true, true)).toBeUndefined()
    expect(partDefaultOpen(textPart("text", "done"), true, true)).toBeUndefined()
  })
})
