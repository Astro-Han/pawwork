import { describe, expect, test } from "bun:test"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { turnWindow } from "../../src/session/processor"

function msg(
  id: string,
  role: "user" | "assistant",
  input?: { parentID?: string; created?: number },
): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      role,
      time: { created: input?.created ?? 1 },
      ...(input?.parentID ? { parentID: MessageID.make(input.parentID) } : {}),
    },
    parts: [],
  } as unknown as MessageV2.WithParts
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
        msg("msg_06", "assistant", { created: 3 }),
        msg("msg_05", "assistant", { created: 3 }),
        msg("msg_04", "user", { created: 2 }),
        msg("msg_03", "assistant", { created: 1 }),
        msg("msg_02", "user", { created: 1 }),
      ]) {
        consumed++
        yield m
      }
    }
    turnWindow(stream(), MessageID.make("msg_04"))
    // msg_03 is the first older timestamp that proves the boundary; msg_02 is never hydrated
    expect(consumed).toBe(4)
  })

  test("returns empty when the parent is the newest message", () => {
    const stream = [msg("msg_04", "user"), msg("msg_03", "assistant")]
    expect(turnWindow(stream, MessageID.make("msg_04"))).toEqual([])
  })

  test("returns everything when the parent is older than the stream tail", () => {
    const stream = [msg("msg_06", "assistant"), msg("msg_05", "user")]
    expect(turnWindow(stream, MessageID.make("msg_01")).length).toBe(2)
  })

  test("keeps the turn when a client-supplied parent ID sorts above its children", () => {
    // the stream is ordered by creation time, not lexically — the prompt API lets
    // clients supply custom message IDs that sort above the generated IDs that follow
    const stream = [
      msg("msg_01J2", "assistant"),
      msg("msg_01J1", "assistant"),
      msg("msg_zzz-custom", "user"),
      msg("msg_01H9", "assistant"),
    ]
    const window = turnWindow(stream, MessageID.make("msg_zzz-custom"))
    expect(window.map((m) => m.info.id)).toEqual([MessageID.make("msg_01J2"), MessageID.make("msg_01J1")])
  })

  test("keeps same-millisecond children when the custom parent ID sorts first", () => {
    const stream = [
      msg("msg_zzz-custom", "user", { created: 2 }),
      msg("msg_01J2", "assistant", { parentID: "msg_zzz-custom", created: 2 }),
      msg("msg_01J1", "assistant", { parentID: "msg_zzz-custom", created: 2 }),
      msg("msg_01H9", "assistant", { created: 1 }),
    ]
    const window = turnWindow(stream, MessageID.make("msg_zzz-custom"))
    expect(window.map((m) => m.info.id)).toEqual([MessageID.make("msg_01J2"), MessageID.make("msg_01J1")])
  })
})
