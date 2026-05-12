import { expect, test, describe } from "bun:test"
import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { groupParts, type PartGroup } from "./message-part-group"

// Minimal factories. Pure-function tests only read a subset of fields
// (type, id, text, tool name, state.status). Other SDK fields are filled
// with stub values so the structural literal type-checks under the SDK union.

function textPart(id: string, text: string): TextPart {
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "text",
    text,
  }
}

function reasoningPart(id: string, text: string): ReasoningPart {
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "reasoning",
    text,
    time: { start: 0 },
  }
}

function toolPart(id: string, tool: string, status: "pending" | "running" | "completed" | "error" = "completed"): ToolPart {
  // ToolState is a discriminated union — branch on status to satisfy each variant's shape.
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

// "Unknown" SDK part types still typecheck against `Part` since the union
// already includes step-start, snapshot, agent, retry, etc. — we use one
// here as the unknown-to-the-grouper carrier.
function stepStartPart(id: string): Part {
  return {
    id,
    sessionID: "s",
    messageID: "m",
    type: "step-start",
  }
}

describe("groupParts", () => {
  test("empty input returns empty array", () => {
    expect(groupParts([])).toEqual([])
  })

  test("text-only emits prose groups in order, no trow-block", () => {
    const result = groupParts([textPart("t1", "hello"), textPart("t2", "world")])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ kind: "prose", partID: "t1", text: "hello" })
    expect(result[1]).toEqual({ kind: "prose", partID: "t2", text: "world" })
  })

  test("tool-only emits a single trow-block holding every tool", () => {
    const tools = [toolPart("a", "bash"), toolPart("b", "bash"), toolPart("c", "edit")]
    const result = groupParts(tools)
    expect(result).toHaveLength(1)
    const group = result[0] as PartGroup
    expect(group.kind).toBe("trow-block")
    if (group.kind !== "trow-block") throw new Error("expected trow-block")
    expect(group.parts.map((p) => p.id)).toEqual(["a", "b", "c"])
  })

  test("interleaved tool/text/tool produces trow-block, prose, trow-block", () => {
    const result = groupParts([
      toolPart("t1", "bash"),
      toolPart("t2", "bash"),
      textPart("p1", "intermediate prose"),
      toolPart("t3", "edit"),
    ])
    expect(result).toHaveLength(3)
    expect(result[0].kind).toBe("trow-block")
    expect(result[1]).toEqual({ kind: "prose", partID: "p1", text: "intermediate prose" })
    expect(result[2].kind).toBe("trow-block")
  })

  test("trailing tools after prose flush as their own trow-block (unflushed-tail guard)", () => {
    const result = groupParts([
      textPart("p1", "first"),
      toolPart("t1", "bash"),
      toolPart("t2", "bash"),
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ kind: "prose", partID: "p1", text: "first" })
    expect(result[1].kind).toBe("trow-block")
  })

  test("reasoning splits a tool run the same way prose does (reasoning is a flush boundary)", () => {
    const result = groupParts([
      toolPart("t1", "bash"),
      reasoningPart("r1", "thinking..."),
      toolPart("t2", "edit"),
    ])
    expect(result).toHaveLength(3)
    expect(result[0].kind).toBe("trow-block")
    expect(result[1]).toEqual({ kind: "reasoning", partID: "r1", text: "thinking..." })
    expect(result[2].kind).toBe("trow-block")
  })

  test("reasoning is a distinct kind from prose (so the renderer can pick different visuals)", () => {
    const result = groupParts([reasoningPart("r1", "step")])
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("reasoning")
  })

  test("hidden tool (todowrite) is filtered before grouping; it does not flush a pending tool run", () => {
    // Two real tools straddling a todowrite — todowrite is filtered out via
    // renderable(), so the two real tools remain consecutive and merge into
    // one trow-block.
    const result = groupParts([
      toolPart("t1", "bash"),
      toolPart("h1", "todowrite"),
      toolPart("t2", "bash"),
    ])
    expect(result).toHaveLength(1)
    if (result[0].kind !== "trow-block") throw new Error("expected single trow-block")
    expect(result[0].parts.map((p) => p.id)).toEqual(["t1", "t2"])
  })

  test("empty text is dropped (renderable() rejects whitespace-only text)", () => {
    const result = groupParts([
      toolPart("t1", "bash"),
      textPart("p1", "   "),
      toolPart("t2", "bash"),
    ])
    // The empty text is not renderable → does not flush. The two tools merge.
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe("trow-block")
  })

  test("question tool while pending/running is filtered (not rendered, not grouped)", () => {
    const result = groupParts([
      toolPart("t1", "bash"),
      toolPart("q1", "question", "pending"),
      toolPart("t2", "bash"),
    ])
    expect(result).toHaveLength(1)
    if (result[0].kind !== "trow-block") throw new Error("expected single trow-block")
    expect(result[0].parts.map((p) => p.id)).toEqual(["t1", "t2"])
  })

  test("unknown / structurally-known-but-non-handled part neither flushes pending tools nor emits a group", () => {
    // step-start is in the SDK union but is not one of the three kinds the
    // grouper handles. Two adjacent tools across a step-start must stay in
    // the same trow-block; the step-start must not appear in output.
    const result = groupParts([
      toolPart("t1", "bash"),
      stepStartPart("s1"),
      toolPart("t2", "bash"),
    ])
    expect(result).toHaveLength(1)
    if (result[0].kind !== "trow-block") throw new Error("expected single trow-block")
    expect(result[0].parts.map((p) => p.id)).toEqual(["t1", "t2"])
  })

  test("preserves part order across multiple flushes", () => {
    const result = groupParts([
      textPart("p1", "a"),
      toolPart("t1", "bash"),
      textPart("p2", "b"),
      toolPart("t2", "edit"),
      toolPart("t3", "edit"),
      textPart("p3", "c"),
    ])
    expect(result.map((g) => g.kind)).toEqual([
      "prose",
      "trow-block",
      "prose",
      "trow-block",
      "prose",
    ])
  })
})
