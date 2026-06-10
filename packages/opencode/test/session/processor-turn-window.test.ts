import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { turnWindow } from "../../src/session/processor"

function msg(id: string, role: "user" | "assistant"): MessageV2.WithParts {
  return { info: { id: MessageID.make(id), role }, parts: [] } as unknown as MessageV2.WithParts
}

describe("turnWindow", () => {
  test("returns only messages newer than the parent, newest-first", () => {
    // stream() order: newest first
    const stream = [
      msg("msg_06", "assistant"),
      msg("msg_05", "assistant"),
      msg("msg_04", "user"),
      msg("msg_03", "assistant"),
      msg("msg_02", "user"),
    ]
    const window = turnWindow(stream, MessageID.make("msg_04"))
    expect(window.map((m) => m.info.id)).toEqual([MessageID.make("msg_06"), MessageID.make("msg_05")])
  })

  test("stops consuming the stream at the parent boundary", () => {
    let consumed = 0
    function* stream() {
      for (const m of [
        msg("msg_06", "assistant"),
        msg("msg_05", "assistant"),
        msg("msg_04", "user"),
        msg("msg_03", "assistant"),
        msg("msg_02", "user"),
      ]) {
        consumed++
        yield m
      }
    }
    turnWindow(stream(), MessageID.make("msg_04"))
    // msg_06, msg_05, then msg_04 triggers the break — msg_03/msg_02 never hydrated
    expect(consumed).toBe(3)
  })

  test("returns empty when the parent is the newest message", () => {
    const stream = [msg("msg_04", "user"), msg("msg_03", "assistant")]
    expect(turnWindow(stream, MessageID.make("msg_04"))).toEqual([])
  })

  test("returns everything when the parent is older than the stream tail", () => {
    const stream = [msg("msg_06", "assistant"), msg("msg_05", "user")]
    expect(turnWindow(stream, MessageID.make("msg_01")).length).toBe(2)
  })
})
