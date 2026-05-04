import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { readTimelineMessages } from "./use-session-timeline-data"

const userMessage = (id: string): Message =>
  ({
    id,
    role: "user",
    sessionID: "ses_target",
    time: { created: 1 },
  }) as Message

describe("readTimelineMessages", () => {
  test("keeps last-good messages for the same session when the current store briefly loses its cache", () => {
    const loaded = [userMessage("msg_1"), userMessage("msg_2")]
    const ready = readTimelineMessages({
      sessionID: "ses_target",
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      sessionID: "ses_target",
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toBe(loaded)
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("keeps a long session window during a same-session cache miss", () => {
    const loaded = Array.from({ length: 80 }, (_, index) => userMessage(`msg_${index}`))
    const ready = readTimelineMessages({
      sessionID: "ses_target",
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      sessionID: "ses_target",
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toHaveLength(80)
    expect(missing.messages).toBe(loaded)
  })

  test("does not reuse last-good messages after switching to another session", () => {
    const loaded = [userMessage("msg_1")]
    const ready = readTimelineMessages({
      sessionID: "ses_source",
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      sessionID: "ses_target",
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toEqual([])
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("clears last-good messages when there is no active session", () => {
    const loaded = [userMessage("msg_1")]
    const ready = readTimelineMessages({
      sessionID: "ses_source",
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      sessionID: undefined,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toEqual([])
    expect(missing.lastGood).toBeUndefined()
  })
})
