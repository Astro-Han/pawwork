import { expect, test } from "bun:test"
import type { FeishuChannel, FeishuInbound } from "./channel.ts"
import { captureFeishuChat } from "./pairing.ts"

function inbound(over: Partial<FeishuInbound> = {}): FeishuInbound {
  return {
    chatId: "oc_group",
    chatType: "group",
    senderId: "ou_alice",
    messageId: "om_1",
    content: "@PawWork hi",
    mentionedBot: true,
    ...over,
  }
}

/** A fake channel that lets a test drive connect and push messages. */
class FakeChannel implements FeishuChannel {
  private handler: ((msg: FeishuInbound) => void) | null = null
  private connectResolve!: () => void
  private readonly gate = new Promise<void>((resolve) => {
    this.connectResolve = resolve
  })
  onMessage(handler: (msg: FeishuInbound) => void): void {
    this.handler = handler
  }
  onError(): void {}
  async connect(): Promise<void> {
    await this.gate
  }
  async disconnect(): Promise<void> {}
  async send(): Promise<void> {}
  allowConnect(): void {
    this.connectResolve()
  }
  push(msg: FeishuInbound): void {
    this.handler?.(msg)
  }
}

test("captures the first group chat that mentions the bot", async () => {
  const channel = new FakeChannel()
  const controller = new AbortController()
  const pairing = captureFeishuChat(channel, controller.signal)
  channel.allowConnect()
  // A p2p message and an unmentioned group message are ignored.
  await Promise.resolve()
  channel.push(inbound({ chatType: "p2p", chatId: "oc_dm" }))
  channel.push(inbound({ mentionedBot: false, chatId: "oc_quiet" }))
  channel.push(inbound({ chatId: "oc_target" }))
  expect(await pairing).toEqual({ chatId: "oc_target" })
})

test("returns null when aborted before a message arrives", async () => {
  const channel = new FakeChannel()
  const controller = new AbortController()
  const pairing = captureFeishuChat(channel, controller.signal)
  channel.allowConnect()
  controller.abort()
  expect(await pairing).toBeNull()
})

test("propagates a connect failure (bad credential)", async () => {
  const channel: FeishuChannel = {
    onMessage() {},
    onError() {},
    connect: () => Promise.reject(new Error("invalid app secret")),
    disconnect: () => Promise.resolve(),
    send: () => Promise.resolve(),
  }
  await expect(captureFeishuChat(channel, new AbortController().signal)).rejects.toThrow("invalid app secret")
})
