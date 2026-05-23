import type { UserMessage } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { createTimelineFrame, emptyTimelineFrame, visibleRangeDataFromFrame } from "./timeline-frame"

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

describe("timeline frame", () => {
  test("starts from a total empty frame", () => {
    expect(emptyTimelineFrame.rows).toEqual([])
    expect(emptyTimelineFrame.mutation).toBe("same")
    expect(emptyTimelineFrame.renderMode).toBe("plain")
    expect(visibleRangeDataFromFrame(emptyTimelineFrame)).toEqual({
      rendered_count: 0,
      visible_first_message_id: undefined,
      visible_last_message_id: undefined,
    })
  })

  test("creates an initial frame from messages", () => {
    const frame = createTimelineFrame({
      previous: emptyTimelineFrame,
      messages: userMessages(0, 2),
      historyMore: false,
      turnStart: 0,
    })

    expect(frame.visibleRange).toEqual({
      rendered_count: 2,
      visible_first_message_id: "msg_0",
      visible_last_message_id: "msg_1",
      signature: "2:msg_0:msg_1",
    })
    expect(frame.rows.map((row) => row.key)).toEqual(["message:msg_0", "message:msg_1"])
    expect(frame.mutation).toBe("initial")
    expect(frame.renderMode).toBe("plain")
  })

  test("preserves row mutation semantics across frame updates", () => {
    const previous = createTimelineFrame({
      previous: emptyTimelineFrame,
      messages: userMessages(5, 8),
      historyMore: false,
      turnStart: 0,
    })

    expect(
      createTimelineFrame({
        previous,
        messages: userMessages(2, 8),
        historyMore: false,
        turnStart: 0,
      }).mutation,
    ).toBe("prepend")
    expect(
      createTimelineFrame({
        previous,
        messages: userMessages(5, 10),
        historyMore: false,
        turnStart: 0,
      }).mutation,
    ).toBe("append")
    expect(
      createTimelineFrame({
        previous,
        messages: userMessages(20, 23),
        historyMore: false,
        turnStart: 0,
      }).mutation,
    ).toBe("replace")
    expect(
      createTimelineFrame({
        previous,
        messages: userMessages(5, 8),
        historyMore: false,
        turnStart: 0,
      }).mutation,
    ).toBe("same")
  })
})
