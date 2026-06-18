import { expect, test } from "bun:test"
import type { Message, Platform } from "../../types.ts"
import type { FeishuChannel, FeishuChannelConfig, FeishuInbound } from "./channel.ts"
import { FeishuPlatform, inboundMessage, parseFeishuRemoteKey } from "./platform.ts"

const GROUP = "oc_group"

function inbound(over: Partial<FeishuInbound> = {}): FeishuInbound {
  return {
    chatId: GROUP,
    chatType: "group",
    senderId: "ou_alice",
    senderName: "Alice",
    messageId: "om_1",
    content: "@PawWork ship it",
    mentionedBot: true,
    ...over,
  }
}

/** A fake FeishuChannel: records sends, lets a test push messages and resolve/reject connect. */
class FakeChannel implements FeishuChannel {
  config: FeishuChannelConfig
  sends: { chatId: string; text: string; replyTo?: string }[] = []
  connected = false
  disconnected = false
  private messageHandler: ((msg: FeishuInbound) => void) | null = null
  private connectResolve!: () => void
  private connectReject!: (err: Error) => void
  readonly connectGate = new Promise<void>((resolve, reject) => {
    this.connectResolve = resolve
    this.connectReject = reject
  })

  constructor(config: FeishuChannelConfig) {
    this.config = config
  }
  onMessage(handler: (msg: FeishuInbound) => void): void {
    this.messageHandler = handler
  }
  onError(): void {}
  async connect(): Promise<void> {
    await this.connectGate
    this.connected = true
  }
  async disconnect(): Promise<void> {
    this.disconnected = true
  }
  async send(chatId: string, text: string, opts?: { replyTo?: string }): Promise<void> {
    this.sends.push({ chatId, text, replyTo: opts?.replyTo })
  }
  // Test helpers.
  push(msg: FeishuInbound): void {
    this.messageHandler?.(msg)
  }
  allowConnect(): void {
    this.connectResolve()
  }
  failConnect(err: Error): void {
    this.connectReject(err)
  }
}

test("inboundMessage accepts a mentioned message in the bound group and strips the mention", () => {
  const msg = inboundMessage(inbound({ content: "@PawWork ship it" }), GROUP, true)
  expect(msg?.content).toBe("ship it")
  expect(msg?.channelID).toBe(GROUP)
  expect(msg?.userID).toBe("ou_alice")
  expect((msg?.replyCtx as { messageId?: string }).messageId).toBe("om_1")
})

test("inboundMessage drops non-group, wrong-chat, and unmentioned messages", () => {
  expect(inboundMessage(inbound({ chatType: "p2p" }), GROUP, true)).toBeNull()
  expect(inboundMessage(inbound({ chatId: "oc_other" }), GROUP, true)).toBeNull()
  expect(inboundMessage(inbound({ mentionedBot: false }), GROUP, true)).toBeNull()
  // A mention with no actual text is nothing to act on.
  expect(inboundMessage(inbound({ content: "@PawWork   " }), GROUP, true)).toBeNull()
})

test("inboundMessage with requireMention off keeps the raw content", () => {
  const msg = inboundMessage(inbound({ content: "no mention here", mentionedBot: false }), GROUP, false)
  expect(msg?.content).toBe("no mention here")
})

test("parseFeishuRemoteKey extracts the chat id, rejecting other shapes", () => {
  expect(parseFeishuRemoteKey("feishu:oc_group:ou_alice")).toEqual({ chatId: "oc_group" })
  expect(parseFeishuRemoteKey("telegram:123:456")).toBeNull()
  expect(parseFeishuRemoteKey("feishu::ou_alice")).toBeNull()
  expect(parseFeishuRemoteKey("feishu")).toBeNull()
})

test("start connects, fires onReady, and routes a bound message to the handler", async () => {
  let fake!: FakeChannel
  const received: Message[] = []
  const platform = new FeishuPlatform({
    appId: "cli_x",
    appSecret: "sec_x",
    domain: "feishu",
    allowChat: GROUP,
    createChannel: (config) => (fake = new FakeChannel(config)),
  })

  let ready = false
  const run = platform.start((_p: Platform, msg) => received.push(msg), () => {
    ready = true
  })
  // Connect is gated: onReady must not fire until the handshake resolves.
  expect(ready).toBe(false)
  expect(fake.config.appId).toBe("cli_x")
  fake.allowConnect()
  await waitUntil(() => ready)

  fake.push(inbound({ content: "@PawWork build" }))
  fake.push(inbound({ chatId: "oc_other", content: "@PawWork ignore me" }))
  expect(received).toHaveLength(1)
  expect(received[0].content).toBe("build")

  await platform.stop()
  await run
  expect(fake.disconnected).toBe(true)
})

test("start rejects when the handshake fails, so the supervisor can restart", async () => {
  let fake!: FakeChannel
  const platform = new FeishuPlatform({
    appId: "cli_x",
    appSecret: "sec_x",
    domain: "feishu",
    allowChat: GROUP,
    createChannel: (config) => (fake = new FakeChannel(config)),
  })
  const run = platform.start(() => {})
  fake.failConnect(new Error("invalid app secret"))
  await expect(run).rejects.toThrow("invalid app secret")
})

test("reply threads under the message; send pushes to the chat", async () => {
  let fake!: FakeChannel
  const platform = new FeishuPlatform({
    appId: "cli_x",
    appSecret: "sec_x",
    domain: "feishu",
    allowChat: GROUP,
    createChannel: (config) => (fake = new FakeChannel(config)),
  })
  const run = platform.start(() => {})
  fake.allowConnect()
  await waitUntil(() => fake.connected)

  await platform.reply({ chatId: GROUP, messageId: "om_42" }, "threaded")
  await platform.send({ chatId: GROUP }, "pushed")
  expect(fake.sends).toEqual([
    { chatId: GROUP, text: "threaded", replyTo: "om_42" },
    { chatId: GROUP, text: "pushed", replyTo: undefined },
  ])

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
