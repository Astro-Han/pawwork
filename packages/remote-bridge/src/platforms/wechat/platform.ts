// WeChat as a bridge Platform, over the iLink long-poll (see client.ts). The
// engine drives this exactly like Telegram; the difference is delivery: iLink has
// no proactive push, so every outbound message must echo the `context_token` from
// the inbound message it answers. That token rides in the reply context, refreshed
// on each user turn — so as long as the user is conversing, replies (including
// permission/question prompts) go through. It also means there is no
// reconstructReplyCtx: a delivery target can't be rebuilt from a remote key alone
// after a restart, so a restored push is logged and skipped, not sent.
//
// There is no delivery window: a reply produced minutes after the inbound message
// still lands. The one lifecycle requirement is `notifyStart` before the first poll
// (the server otherwise treats the bot as inactive and stops delivering after the
// first reply). There is no matching notifyStop: the bridge rebuilds on any channel
// change, so an offline call on stop would race the next connection's notifyStart for
// the same token; iLink drops a bot that stops polling, so stop just stops polling.
//
// iLink is a 1:1 DM channel (the user's personal WeChat talks to their bot slot),
// so channelID and userID are the same sender id and there is no group concept.

import type { Message, MessageHandler, Platform } from "../../types.ts"
import {
  isFatalWeChatError,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_USER,
  type WeChatMessage,
  type WeChatUpdates,
} from "./client.ts"

const POLL_RETRY_MS = 3_000
const MAX_RETRY_MS = 30_000

/** The slice of WeChatClient the adapter needs; lets tests inject a fake. */
export interface WeChatTransport {
  getUpdates(cursor: string, signal?: AbortSignal): Promise<WeChatUpdates>
  sendMessage(toUserId: string, contextToken: string, text: string, signal?: AbortSignal): Promise<void>
  notifyStart(signal?: AbortSignal): Promise<void>
}

export interface WeChatReplyContext {
  toUserId: string
  /** Lifted from the inbound message; iLink rejects a send without it. */
  contextToken: string
}

/**
 * Shape an inbound iLink message into the engine's `Message`, or null if it should
 * be dropped: a non-user message (the bot's own echo), an unfinished stream, a
 * sender other than the paired `allowFrom`, empty text, or one with no
 * context_token (we could not reply to it anyway). Drops are silent — a bounce
 * would let a stranger probe the policy.
 */
export function inboundMessage(msg: WeChatMessage, allowFrom: string): Message | null {
  if (msg.messageType !== MESSAGE_TYPE_USER) return null
  if (msg.messageState !== MESSAGE_STATE_FINISH) return null
  if (msg.fromUserId !== allowFrom) return null
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
    let started = false
    let ready = false
    let backoff = this.pollRetryMs
    while (!signal.aborted) {
      let updates: WeChatUpdates
      try {
        // Mark the bot online before the first poll. iLink delivers only the first
        // reply per connection to a bot it has not seen notifyStart from, so a failed
        // notifyStart silently reproduces that drop while we look connected — it must
        // not be swallowed. Folded into the loop's discipline: a fatal token error
        // rejects start(), a transient one backs off and retries, and `ready` (the
        // "connected" signal) only fires once the bot is actually online.
        if (!started) {
          await this.opts.transport.notifyStart(signal)
          started = true
        }
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
      for (const msg of updates.messages) {
        try {
          this.dispatch(handler, msg)
        } catch {
          // a handler failure must not stall the poll loop (mirrors TelegramPoller)
        }
      }
    }
  }

  private dispatch(handler: MessageHandler, msg: WeChatMessage): void {
    const inbound = inboundMessage(msg, this.allowFrom)
    if (!inbound) return
    handler(this, inbound)
  }

  async reply(replyCtx: unknown, content: string): Promise<void> {
    const ctx = replyCtx as WeChatReplyContext
    await this.opts.transport.sendMessage(ctx.toUserId, ctx.contextToken, content)
  }

  send(replyCtx: unknown, content: string): Promise<void> {
    return this.reply(replyCtx, content)
  }

  async stop(): Promise<void> {
    this.ac?.abort()
    if (this.loop) await this.loop.catch(() => {})
    // No notifyStop: the bridge rebuilds on any channel change (connect/disconnect a
    // *different* platform tears every channel down and back up), so a notifyStop here
    // races the next connection's notifyStart for the same token — and since it would
    // fly detached from the abort, an old "offline" could land after the new "online"
    // and silently re-mark the bot offline. iLink drops a bot that stops polling on its
    // own, so we just stop polling; notifyStart on the next start is what matters.
  }
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
