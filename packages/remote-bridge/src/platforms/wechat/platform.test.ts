import { expect, test } from "bun:test"
import type { Platform } from "../../types.ts"
import { WeChatApiError, type WeChatMessage, type WeChatUpdates } from "./client.ts"
import { inboundMessage, WeChatPlatform, type WeChatTransport } from "./platform.ts"

const USER = "u_alice@im.wechat"

function wxMsg(over: Partial<WeChatMessage> = {}): WeChatMessage {
  return {
    fromUserId: USER,
    toUserId: "bot@im.bot",
    messageType: 1,
    messageState: 2,
    contextToken: "ctx-1",
    items: [{ type: 1, text: "hello" }],
    ...over,
  }
}

/** A controllable transport: queued update batches, then blocks until abort. */
class FakeTransport implements WeChatTransport {
  sends: { toUserId: string; contextToken: string; text: string }[] = []
  notifyStarts = 0
  /** Set true if a poll ever ran before notifyStart — proves the ordering is wrong. */
  polledBeforeStart = false
  /** When set, notifyStart rejects with it (to test the failure path). */
  notifyStartError: Error | undefined
  /** When true, the next getUpdates throws once (a transient, non-fatal blip). */
  failGetUpdatesOnce = false
  private readonly batches: WeChatMessage[][] = []
  pushBatch(msgs: WeChatMessage[]): void {
    this.batches.push(msgs)
  }
  async getUpdates(cursor: string, signal?: AbortSignal): Promise<WeChatUpdates> {
    if (this.notifyStarts === 0) this.polledBeforeStart = true
    if (this.failGetUpdatesOnce) {
      this.failGetUpdatesOnce = false
      throw new Error("transient getUpdates failure")
    }
    const next = this.batches.shift()
    if (next) return { messages: next, cursor: "cursor-next" }
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      signal?.addEventListener("abort", () => resolve(), { once: true })
    })
    return { messages: [], cursor }
  }
  async sendMessage(toUserId: string, contextToken: string, text: string): Promise<void> {
    this.sends.push({ toUserId, contextToken, text })
  }
  async notifyStart(): Promise<void> {
    if (this.notifyStartError) throw this.notifyStartError
    this.notifyStarts++
  }
}

test("inboundMessage accepts a finished user text from the paired sender", () => {
  const msg = inboundMessage(wxMsg({ items: [{ type: 1, text: "ship it" }] }), USER)
  expect(msg?.content).toBe("ship it")
  expect(msg?.channelID).toBe(USER)
  expect(msg?.userID).toBe(USER)
  expect(msg?.replyCtx).toEqual({ toUserId: USER, contextToken: "ctx-1" })
})

test("inboundMessage drops bot echoes, wrong senders, tokenless, unfinished, and empty", () => {
  expect(inboundMessage(wxMsg({ messageType: 2 }), USER)).toBeNull() // bot's own echo
  expect(inboundMessage(wxMsg({ fromUserId: "someone@im.wechat" }), USER)).toBeNull()
  expect(inboundMessage(wxMsg({ contextToken: "" }), USER)).toBeNull() // unreplyable
  expect(inboundMessage(wxMsg({ messageState: 1 }), USER)).toBeNull() // still streaming
  expect(inboundMessage(wxMsg({ items: [{ type: 1, text: "   " }] }), USER)).toBeNull()
})

test("start fires onReady, routes a paired message, and replies with its context token", async () => {
  const transport = new FakeTransport()
  transport.pushBatch([wxMsg({ items: [{ type: 1, text: "build" }] }), wxMsg({ messageType: 2 })])
  const platform = new WeChatPlatform({ transport, allowFrom: USER })
  platform.pollRetryMs = 1

  const received: string[] = []
  let ready = false
  const run = platform.start(
    (_p: Platform, msg) => received.push(msg.content),
    () => {
      ready = true
    },
  )
  await waitUntil(() => ready)
  await waitUntil(() => received.length === 1)
  expect(received).toEqual(["build"]) // the bot echo was dropped

  await platform.reply({ toUserId: USER, contextToken: "ctx-9" }, "done")
  expect(transport.sends).toEqual([{ toUserId: USER, contextToken: "ctx-9", text: "done" }])

  await platform.stop()
  await run
})

test("notifyStart precedes the first poll; stop tears down without a second online signal", async () => {
  const transport = new FakeTransport()
  transport.pushBatch([wxMsg({ items: [{ type: 1, text: "hi" }] })])
  const platform = new WeChatPlatform({ transport, allowFrom: USER })
  platform.pollRetryMs = 1

  let ready = false
  const run = platform.start(
    () => {},
    () => {
      ready = true
    },
  )
  await waitUntil(() => ready)
  expect(transport.notifyStarts).toBe(1)
  expect(transport.polledBeforeStart).toBe(false) // online before any poll

  // stop() only aborts the poll loop — no offline call. The bridge rebuilds on any
  // channel change, so an offline signal here would fly detached from the abort and
  // could land after the next connection's notifyStart, re-marking the bot offline.
  await platform.stop()
  await run
  expect(transport.notifyStarts).toBe(1) // exactly one online signal across the whole lifecycle
})

test("a fatal notifyStart error rejects start instead of polling silently", async () => {
  const transport = new FakeTransport()
  // A bad token: notifyStart can't mark the bot online, so surfacing it beats
  // looking connected while every reply after the first is silently dropped.
  transport.notifyStartError = new WeChatApiError("/ilink/bot/msg/notifystart", 401, undefined, "bad token")
  const platform = new WeChatPlatform({ transport, allowFrom: USER })
  platform.pollRetryMs = 1

  await expect(platform.start(() => {})).rejects.toThrow()
  expect(transport.polledBeforeStart).toBe(false) // never polled — online failed first
  expect(transport.sends).toEqual([])
})

test("a throwing handler does not stall the poll loop or kill the channel", async () => {
  const transport = new FakeTransport()
  transport.pushBatch([
    wxMsg({ items: [{ type: 1, text: "boom" }] }),
    wxMsg({ items: [{ type: 1, text: "after" }] }),
  ])
  const platform = new WeChatPlatform({ transport, allowFrom: USER })
  platform.pollRetryMs = 1

  const received: string[] = []
  const run = platform.start((_p: Platform, msg) => {
    if (msg.content === "boom") throw new Error("handler blew up")
    received.push(msg.content)
  })
  await waitUntil(() => received.includes("after"))
  expect(received).toEqual(["after"]) // the throw on "boom" didn't drop the next message

  await platform.stop()
  await run // the loop survived — start() resolved rather than rejecting
})

test("does not re-notifyStart after a transient poll failure within one connection", async () => {
  const transport = new FakeTransport()
  transport.failGetUpdatesOnce = true // online is asserted, then the first poll blips
  transport.pushBatch([wxMsg({ items: [{ type: 1, text: "hi" }] })])
  const platform = new WeChatPlatform({ transport, allowFrom: USER })
  platform.pollRetryMs = 1

  let ready = false
  const run = platform.start(
    () => {},
    () => {
      ready = true
    },
  )
  await waitUntil(() => ready)
  expect(transport.notifyStarts).toBe(1) // re-asserted on reconnect (fresh start), not on an in-loop blip

  await platform.stop()
  await run
})

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now()
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((r) => setTimeout(r, 1))
  }
}
