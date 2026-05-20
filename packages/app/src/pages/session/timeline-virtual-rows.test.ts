import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { classifyTimelineRowMutation, createTimelineVirtualRows } from "./timeline-virtual-rows"

function userMessage(id: number): UserMessage {
  return {
    id: `msg_${id}`,
    role: "user",
    time: { created: id },
  } as UserMessage
}

function userMessages(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => userMessage(start + index))
}

describe("timeline virtual rows", () => {
  test("creates one stable message row per user message", () => {
    const rows = createTimelineVirtualRows({ messages: userMessages(0, 3), historyMore: false, turnStart: 0 })

    expect(rows).toEqual([
      expect.objectContaining({ type: "message", key: "message:msg_0", messageID: "msg_0", messageIndex: 0 }),
      expect.objectContaining({ type: "message", key: "message:msg_1", messageID: "msg_1", messageIndex: 1 }),
      expect.objectContaining({ type: "message", key: "message:msg_2", messageID: "msg_2", messageIndex: 2 }),
    ])
  })

  test("adds the load-earlier row when cached or remote history exists", () => {
    expect(createTimelineVirtualRows({ messages: userMessages(0, 1), historyMore: false, turnStart: 2 })[0]).toEqual({
      type: "load-earlier",
      key: "history-load-earlier",
    })
    expect(createTimelineVirtualRows({ messages: userMessages(0, 1), historyMore: true, turnStart: 0 })[0]).toEqual({
      type: "load-earlier",
      key: "history-load-earlier",
    })
  })

  test("classifies prepends and appends without using row indexes as identity", () => {
    const previous = createTimelineVirtualRows({ messages: userMessages(5, 8), historyMore: false, turnStart: 0 })
    const prepended = createTimelineVirtualRows({ messages: userMessages(2, 8), historyMore: false, turnStart: 0 })
    const appended = createTimelineVirtualRows({ messages: userMessages(5, 10), historyMore: false, turnStart: 0 })

    expect(classifyTimelineRowMutation({ previous, next: prepended })).toBe("prepend")
    expect(classifyTimelineRowMutation({ previous, next: appended })).toBe("append")
  })

  test("classifies replacement when neither end remains stable", () => {
    const previous = createTimelineVirtualRows({ messages: userMessages(5, 8), historyMore: false, turnStart: 0 })
    const next = createTimelineVirtualRows({ messages: userMessages(20, 23), historyMore: false, turnStart: 0 })

    expect(classifyTimelineRowMutation({ previous, next })).toBe("replace")
  })
})
