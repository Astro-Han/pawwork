// Feishu / Lark as a bridge Platform, over the SDK's websocket long connection
// (see `channel.ts` for the seam). The engine drives this exactly like Telegram;
// only the transport and pairing differ. Unlike Telegram's getUpdates, Feishu's
// long connection does not queue events for an offline client, so there is no
// backlog to drain on (re)start — a clean handshake means we are serving.
//
// Group hygiene: a bot in a shared group must not answer every message, so the
// adapter accepts only messages in the bound chat (`allowChat`) that @mention the
// bot (`requireMention`), dropping the rest silently. The inbound message carries
// channelID/userID but no sessionKey, so the engine derives `feishu:<chatId>:<senderId>`
// and keeps the platform prefix it needs to restore delivery after a restart.

import type { Message, MessageHandler, Platform } from "../../types.ts"
import { type FeishuChannel, type FeishuChannelFactory, type FeishuInbound, stripLeadingMentions } from "./channel.ts"
import type { FeishuDomain } from "./registration.ts"

export interface FeishuReplyContext {
  chatId: string
  /** The triggering message id, so a reply can thread under it. Absent after a
   * restart-time reconstruct, where only the chat id survives. */
  messageId?: string
}

export interface FeishuPlatformOptions {
  appId: string
  appSecret: string
  domain: FeishuDomain
  /** The bound group chat_id this bot serves; messages elsewhere are dropped. */
  allowChat: string
  /** Require an @mention to act on a group message. Defaults to true. */
  requireMention?: boolean
  /** Channel transport, injected for tests; production passes createFeishuChannel. */
  createChannel: FeishuChannelFactory
}

/**
 * Decide whether an inbound Feishu message should drive the agent, and shape it
 * into the engine's `Message`. Returns null for anything dropped: a non-group
 * chat, a message outside the bound chat, or (when required) one that does not
 * @mention the bot. Drops are silent by design — a bounce would let a stranger
 * probe the policy. Exposed for unit tests.
 */
export function inboundMessage(msg: FeishuInbound, allowChat: string, requireMention: boolean): Message | null {
  if (msg.chatType !== "group") return null
  if (msg.chatId !== allowChat) return null
  if (requireMention && !msg.mentionedBot) return null
  const content = (requireMention ? stripLeadingMentions(msg.content) : msg.content).trim()
  if (content === "") return null
  return {
    content,
    replyCtx: { chatId: msg.chatId, messageId: msg.messageId } satisfies FeishuReplyContext,
    channelID: msg.chatId,
    userID: msg.senderId,
  }
}

/**
 * Rebuild a reply target from a remote key. The engine stores keys as
 * `feishu:<chatId>:<senderId>`; Feishu chat/user ids never contain colons, so a
 * plain split is safe. Only the chat id is recoverable — a restored reply pushes
 * to the chat rather than threading under the (now unknown) original message.
 */
export function parseFeishuRemoteKey(key: string): { chatId: string } | null {
  const parts = key.split(":")
  if (parts.length < 3 || parts[0] !== "feishu") return null
  const chatId = parts[1]
  if (chatId.trim() === "") return null
  return { chatId }
}

export class FeishuPlatform implements Platform {
  readonly name = "feishu"
  private readonly allowChat: string
  private readonly requireMention: boolean
  private channel: FeishuChannel | null = null
  private stopResolve: (() => void) | null = null

  constructor(private readonly opts: FeishuPlatformOptions) {
    this.allowChat = opts.allowChat.trim()
    this.requireMention = opts.requireMention ?? true
  }

  async start(handler: MessageHandler, onReady?: () => void): Promise<void> {
    if (this.channel) return
    const channel = this.opts.createChannel({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: this.opts.domain,
    })
    this.channel = channel
    channel.onMessage((msg) => this.dispatch(handler, msg))
    // Send-level and transient WS errors are logged, not fatal: the SDK
    // auto-reconnects, so one failure must not tear the adapter down.
    channel.onError((err) => console.warn("remote bridge feishu channel error", message(err)))
    const stopped = new Promise<void>((resolve) => {
      this.stopResolve = resolve
    })
    try {
      // connect() resolves after the first handshake and rejects on a bad
      // credential; the supervisor turns a rejection into degraded + backoff.
      // There is no backlog to drain, so a clean connect means we are serving.
      await channel.connect()
      onReady?.()
      // The SDK keeps the connection alive (auto-reconnect) in the background;
      // hold start() open until stop() so the supervisor treats us as serving.
      await stopped
    } finally {
      this.channel = null
      this.stopResolve = null
    }
  }

  private dispatch(handler: MessageHandler, msg: FeishuInbound): void {
    const inbound = inboundMessage(msg, this.allowChat, this.requireMention)
    if (inbound) handler(this, inbound)
  }

  reply(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as FeishuReplyContext
    return this.send_(ctx.chatId, content, ctx.messageId)
  }

  send(replyCtx: unknown, content: string): Promise<void> {
    return this.send_((replyCtx as FeishuReplyContext).chatId, content)
  }

  private send_(chatId: string, content: string, replyTo?: string): Promise<void> {
    if (!this.channel) return Promise.reject(new Error("feishu channel is not connected"))
    return this.channel.send(chatId, content, replyTo ? { replyTo } : undefined)
  }

  async stop(): Promise<void> {
    const channel = this.channel
    this.stopResolve?.()
    if (channel) await channel.disconnect().catch(() => {})
  }

  reconstructReplyCtx(remoteKey: string): FeishuReplyContext {
    const ctx = parseFeishuRemoteKey(remoteKey)
    if (!ctx) throw new Error(`feishu: cannot reconstruct reply context from "${remoteKey}"`)
    return { chatId: ctx.chatId }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
