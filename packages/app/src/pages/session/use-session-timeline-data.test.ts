import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { readTimelineMessages, readTimelineMessagesFromCache, timelineModelSyncKey } from "./use-session-timeline-data"

const userMessage = (id: string, sessionID = "ses_target"): Message =>
  ({
    id,
    role: "user",
    sessionID,
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
    const loaded = [userMessage("msg_1", "ses_source")]
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

  test("does not reuse last-good messages after the same session id gets a different identity scope", () => {
    const loaded = [userMessage("msg_1")]
    const ready = readTimelineMessages({
      sessionID: "ses_target",
      dataIdentity: "server-a:ses_target",
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      sessionID: "ses_target",
      dataIdentity: "server-b:ses_target",
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toEqual([])
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("keeps last-good messages when the same session cache misses before session info reloads", () => {
    const loaded = [userMessage("msg_1"), userMessage("msg_2")]
    const ready = readTimelineMessages({
      sessionID: "ses_target",
      dataIdentity: "ses_target:123",
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessages({
      sessionID: "ses_target",
      dataIdentity: undefined,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toBe(loaded)
    expect(missing.lastGood).toBe(ready.lastGood)
  })

  test("clears last-good messages when there is no active session", () => {
    const loaded = [userMessage("msg_1", "ses_source")]
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

  test("treats an empty raw message array as authoritative loaded data", () => {
    const ready = readTimelineMessages({
      sessionID: "ses_target",
      raw: [userMessage("msg_1"), userMessage("msg_2")],
      lastGood: undefined,
    })

    const empty = readTimelineMessages({
      sessionID: "ses_target",
      raw: [],
      lastGood: ready.lastGood,
    })

    expect(empty.messages).toEqual([])
    expect(empty.lastGood?.messages).toEqual([])
  })
})

describe("readTimelineMessagesFromCache", () => {
  test("keeps messages when directory switch makes session info and message cache briefly unavailable", () => {
    const loaded = [userMessage("msg_1"), userMessage("msg_2")]
    const ready = readTimelineMessagesFromCache({
      sessionID: "ses_target",
      sessionCreated: 123,
      raw: loaded,
      lastGood: undefined,
    })

    const missing = readTimelineMessagesFromCache({
      sessionID: "ses_target",
      sessionCreated: undefined,
      raw: undefined,
      lastGood: ready.lastGood,
    })

    expect(missing.messages).toBe(loaded)
    expect(missing.lastGood).toBe(ready.lastGood)
  })
})

describe("timelineModelSyncKey", () => {
  test("changes when the directory changes even if the last user message is the same", () => {
    expect(timelineModelSyncKey({ directory: "/worktree", messageID: "msg" })).not.toBe(
      timelineModelSyncKey({ directory: "/root", messageID: "msg" }),
    )
  })
})
