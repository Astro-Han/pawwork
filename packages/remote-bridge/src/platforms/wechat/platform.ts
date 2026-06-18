// WeChat as a bridge Platform, over the iLink long-poll (see client.ts). The
// engine drives this exactly like Telegram; the difference is delivery: iLink has
// no proactive push, so every outbound message must echo the `context_token` from
// the inbound message it answers. That token rides in the reply context, refreshed
// on each user turn — so as long as the user is conversing, replies (including
// permission/question prompts) go through. It also means there is no
// reconstructReplyCtx: a delivery target can't be rebuilt from a remote key alone
// after a restart, so a restored push is logged and skipped, not sent.
//
// iLink is a 1:1 DM channel (the user's personal WeChat talks to their bot slot),
// so channelID and userID are the same sender id and there is no group concept.

import type { Message, MessageHandler, Platform } from "../../types.ts"
import { isFatalWeChatError, MESSAGE_STATE_FINISH, MESSAGE_TYPE_USER, type WeChatMessage, type WeChatUpdates } from "./client.ts"

const POLL_RETRY_MS = 3_000
const MAX_RETRY_MS = 30_000

/** The slice of WeChatClient the adapter needs; lets tests inject a fake. */
export interface WeChatTransport {
  getUpdates(cursor: string, signal?: AbortSignal): Promise<WeChatUpdates>
  sendMessage(toUserId: string, contextToken: string, text: string, signal?: AbortSignal): Promise<void>
}

export interface WeChatReplyContext {
  toUserId: string
  /** Lifted from the inbound message; iLink rejects a send without it. */
  contextToken: string
}

/**
 * Shape an inbound iLink message into the engine's `Message`, or null if it should
 * be dropped: a non-user message (the bot's own echo), an unfinished stream, a
 * sender other than the paired `allowFrom` ("" accepts any, used only by capture),
 * empty text, or one with no context_token (we could not reply to it anyway).
 * Drops are silent — a bounce would let a stranger probe the policy.
 */
export function inboundMessage(msg: WeChatMessage, allowFrom: string): Message | null {
  if (msg.messageType !== MESSAGE_TYPE_USER) return null
  if (msg.messageState !== MESSAGE_STATE_FINISH) return null
  if (allowFrom !== "" && msg.fromUserId !== allowFrom) return null
  if (msg.contextToken === "") return null
  const text = msg.items
    .map((item) => item.text ?? "")
    .join("")
    .trim()
  if (text === "") return null
  return {
    content: text,
    replyCtx: { toUserId: msg.fromUserId, contextToken: msg.contextToken } satisfies WeChatReplyContext,
    channelID: msg.fromUserId,
    userID: msg.fromUserId,
  }
}

export class WeChatPlatform implements Platform {
  readonly name = "wechat"
  private readonly allowFrom: string
  /** Base poll backoff, mutable so tests can drop it to zero. */
  pollRetryMs = POLL_RETRY_MS
  private ac: AbortController | null = null
  private loop: Promise<void> | null = null

  constructor(private readonly opts: { transport: WeChatTransport; allowFrom: string }) {
    this.allowFrom = opts.allowFrom.trim()
  }

  async start(handler: MessageHandler, onReady?: () => void): Promise<void> {
    if (this.ac) return
    const ac = new AbortController()
    this.ac = ac
    try {
      this.loop = this.runLoop(handler, ac.signal, onReady)
      await this.loop
    } finally {
      this.ac = null
      this.loop = null
    }
  }

  /**
   * Long-poll for messages, dispatching each to the handler. `onReady` fires after
   * the first getUpdates returns — the proof the token is live. A fatal error (bad
   * token) rejects so the supervisor surfaces it; transient errors back off and
   * retry. The opaque cursor is treated as "from now": iLink does not redeliver an
   * already-cursored message, so there is no Telegram-style backlog to drain.
   */
  private async runLoop(handler: MessageHandler, signal: AbortSignal, onReady?: () => void): Promise<void> {
    let cursor = ""
    let ready = false
    let backoff = this.pollRetryMs
    while (!signal.aborted) {
      let updates: WeChatUpdates
      try {
        updates = await this.opts.transport.getUpdates(cursor, signal)
      } catch (err) {
        if (signal.aborted) return
        if (isFatalWeChatError(err)) throw err
        await sleep(backoff, signal)
        backoff = Math.min(backoff * 2, MAX_RETRY_MS)
        continue
      }
      backoff = this.pollRetryMs
      cursor = updates.cursor
      if (!ready) {
        ready = true
        onReady?.()
      }
      for (const msg of updates.messages) this.dispatch(handler, msg)
    }
  }

  private dispatch(handler: MessageHandler, msg: WeChatMessage): void {
    const inbound = inboundMessage(msg, this.allowFrom)
    if (inbound) handler(this, inbound)
  }

  reply(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as WeChatReplyContext
    return this.opts.transport.sendMessage(ctx.toUserId, ctx.contextToken, content)
  }

  send(replyCtx: unknown, content: string): Promise<void> {
    return this.reply(replyCtx, content)
  }

  async stop(): Promise<void> {
    this.ac?.abort()
    if (this.loop) await this.loop.catch(() => {})
  }
}

/**
 * Pairing capture: identify the paired user by returning the first inbound
 * sender's id (their personal WeChat talking to the freshly-logged-in bot). Runs
 * on its own poll before the steady-state platform starts — the two never poll the
 * same token at once. Returns null if the signal aborts first.
 */
export async function captureWeChatSender(transport: WeChatTransport, signal: AbortSignal): Promise<string | null> {
  let cursor = ""
  while (!signal.aborted) {
    let updates: WeChatUpdates
    try {
      updates = await transport.getUpdates(cursor, signal)
    } catch (err) {
      if (signal.aborted) return null
      throw err
    }
    cursor = updates.cursor
    for (const msg of updates.messages) {
      if (inboundMessage(msg, "")) return msg.fromUserId
    }
  }
  return null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
