import { expect, test } from "bun:test"
import type { Platform } from "../../types.ts"
import type { WeChatMessage, WeChatUpdates } from "./client.ts"
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
  private readonly batches: WeChatMessage[][] = []
  pushBatch(msgs: WeChatMessage[]): void {
    this.batches.push(msgs)
  }
  async getUpdates(cursor: string, signal?: AbortSignal): Promise<WeChatUpdates> {
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

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now()
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((r) => setTimeout(r, 1))
  }
}
