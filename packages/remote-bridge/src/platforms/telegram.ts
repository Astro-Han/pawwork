// Telegram as a bridge Platform. A thin wrapper over the raw Bot API
// (getUpdates long-poll + sendMessage), no SDK: the API is near-additive and a
// single desktop long-poll consumer needs offset/abort/backoff control more
// than a middleware framework. The engine drives this exactly like any other
// `Platform`; pairing (capturing the first sender before an allow_from exists)
// reuses the same `TelegramPoller` primitive — see `captureFirstSender`.

import type { Message, MessageHandler, Platform } from "../types.ts"

const API_BASE = "https://api.telegram.org"
// Telegram holds a getUpdates request open for up to this many seconds before
// returning empty; the HTTP timeout below must outlast it.
const POLL_TIMEOUT_S = 25
const REQUEST_TIMEOUT_MS = 10_000
// Base backoff between transient getUpdates failures; a 429 overrides it with
// the server's retry_after. Lowered in tests.
const POLL_RETRY_MS = 3_000

// Telegram caps a message at 4096 UTF-16 code units (NOT codepoints): an
// astral-plane char (most emoji, CJK ext-B) costs 2. Splitting long assistant
// replies is correctness — an over-cap send returns 400 and the user gets
// nothing. Pulled to 4000 so an "[i/N]" continuation header fits under the cap.
const MAX_UTF16_PER_MESSAGE = 4000

/** A Bot API call failed. `errorCode` is Telegram's `error_code` when present,
 * else the HTTP status; `retryAfterMs` is set only for 429 (clamped). */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly httpStatus: number,
    readonly errorCode: number | undefined,
    readonly description: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`telegram ${method} failed: ${httpStatus}${errorCode ? ` (${errorCode})` : ""} ${description}`.trim())
    this.name = "TelegramApiError"
  }
}

/**
 * Whether a Bot API error is permanent. A bad/blocked token (401/403) or a
 * missing method (404) cannot be fixed by retrying, so the poll loop surfaces
 * it (rejecting `start()`) instead of spinning. Everything else — 409 conflict,
 * 429, 5xx, network — is transient and retried with backoff.
 */
export function isFatalTelegramError(err: unknown): boolean {
  if (err instanceof TelegramApiError) {
    const code = err.errorCode ?? err.httpStatus
    return code === 401 || code === 403 || code === 404
  }
  return false
}

export interface TelegramIdentity {
  id: string
  username?: string
  displayName?: string
}

export interface NormalizedUpdate {
  updateId: number
  chatId: string
  userId: string
  userName: string
  text: string
  isPrivate: boolean
}

/**
 * Normalize a raw getUpdates entry to the fields the bridge needs, or null if
 * it carries no usable text. v1 is text-only: a photo/sticker/voice update
 * normalizes to null and is skipped (but its update_id still advances the
 * offset so it is acked, not refetched).
 */
export function normalizeUpdate(update: unknown): NormalizedUpdate | null {
  if (!update || typeof update !== "object") return null
  const message = (update as { message?: any }).message
  if (!message || typeof message !== "object" || !message.from || !message.chat) return null
  const text = typeof message.text === "string" ? message.text : ""
  if (text.trim() === "") return null
  return {
    updateId: Number((update as { update_id?: unknown }).update_id),
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    userName: message.from.username ?? message.from.first_name ?? String(message.from.id),
    text,
    isPrivate: message.chat.type === "private",
  }
}

/**
 * Turn a raw update into the inbound `Message` the engine expects, or null if
 * it should be dropped. v1 accepts only private chats from the paired user
 * (`allowFrom`); a "" allowFrom accepts any private sender (used only by the
 * pairing capture, never steady state). Drops are silent by design — a bounce
 * would let a stranger probe the policy. No sessionKey is set, so the engine
 * derives `telegram:<chatId>:<userId>` and keeps the platform prefix it needs
 * to restore delivery after a restart.
 */
export function inboundMessage(update: unknown, allowFrom: string): Message | null {
  const norm = normalizeUpdate(update)
  if (!norm) return null
  if (!norm.isPrivate) return null
  if (allowFrom !== "" && norm.userId !== allowFrom) return null
  return {
    content: norm.text,
    replyCtx: { chatId: norm.chatId },
    channelID: norm.chatId,
    userID: norm.userId,
  }
}

/**
 * Rebuild a reply target from a remote key. The engine stores keys as
 * `telegram:<chatId>:<userId>` (built from platform name + channelID + userID),
 * so the chat id is the second segment. chat/user ids are integers, never
 * embedded colons, so a plain split is safe. Returns null on any other shape.
 */
export function parseTelegramRemoteKey(key: string): { chatId: string } | null {
  const parts = key.split(":")
  if (parts.length < 3 || parts[0] !== "telegram") return null
  const chatId = parts[1]
  if (chatId.trim() === "") return null
  return { chatId }
}

/** Longest prefix of `s` whose UTF-16 length is <= `cap`, never splitting a
 * surrogate pair. (`String.length` already counts UTF-16 code units.) */
function prefixWithinUtf16(s: string, cap: number): string {
  if (s.length <= cap) return s
  let used = 0
  let end = 0
  for (let i = 0; i < s.length; ) {
    const code = s.codePointAt(i)!
    const units = code > 0xffff ? 2 : 1
    if (used + units > cap) break
    used += units
    i += units
    end = i
  }
  return s.slice(0, end)
}

/**
 * Split `text` into UTF-16-bounded chunks for delivery, preferring a newline
 * break near the end of each chunk. A single-chunk message is returned as-is
 * with no header; a multi-chunk message gets an "[i/N]" header so the receiver
 * knows it was split rather than seeing N unexplained messages.
 */
export function splitForTelegram(text: string): string[] {
  if (text.length <= MAX_UTF16_PER_MESSAGE) return [text]
  const HEADER_RESERVE = 12 // "[99/99]\n"
  const cap = MAX_UTF16_PER_MESSAGE - HEADER_RESERVE
  const pieces: string[] = []
  let remaining = text
  while (remaining.length > cap) {
    let chunk = prefixWithinUtf16(remaining, cap)
    const minBoundary = Math.floor(chunk.length * 0.9)
    const nl = chunk.lastIndexOf("\n")
    if (nl >= minBoundary) chunk = chunk.slice(0, nl)
    pieces.push(chunk)
    remaining = remaining.slice(chunk.length).replace(/^\n/, "")
  }
  if (remaining.length > 0) pieces.push(remaining)
  const total = pieces.length
  return pieces.map((piece, idx) => `[${idx + 1}/${total}]\n${piece}`)
}

/**
 * Low-level Bot API primitive: getMe / getUpdates / sendMessage plus a long-poll
 * loop. Shared by `TelegramPlatform` (steady state) and `captureFirstSender`
 * (pairing) so the offset/abort/backoff handling lives in exactly one place and
 * the two never poll the same token concurrently.
 */
export class TelegramPoller {
  /** Base poll backoff, mutable so tests can drop it to zero. */
  pollRetryMs = POLL_RETRY_MS
  private readonly baseUrl: string

  // `baseUrl` defaults to the real Bot API; tests point it at a local server.
  constructor(private readonly token: string, baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
  }

  async getMe(signal?: AbortSignal): Promise<TelegramIdentity> {
    const me = await this.call("getMe", {}, signal, REQUEST_TIMEOUT_MS)
    return {
      id: String(me?.id ?? ""),
      username: me?.username,
      displayName: me?.first_name,
    }
  }

  /** One getUpdates call. `offset` acks every update below it; 0/omitted returns
   * all currently-unconfirmed updates. `timeoutS` is Telegram's long-poll hold;
   * 0 returns immediately (used to drain backlog / ack during pairing). */
  async getUpdates(offset: number, signal?: AbortSignal, timeoutS: number = POLL_TIMEOUT_S): Promise<any[]> {
    const result = await this.call(
      "getUpdates",
      { offset, timeout: timeoutS, allowed_updates: ["message"] },
      signal,
      (timeoutS + 5) * 1_000,
    )
    return Array.isArray(result) ? result : []
  }

  /**
   * Long-poll from `startOffset`, calling `onUpdate` for each raw update. The
   * offset advances past every update returned (even ones `onUpdate` ignores)
   * so nothing is refetched. Resolves when `signal` aborts; rejects only on a
   * fatal error — transient failures back off and retry. `onUpdate` errors are
   * swallowed so one bad message cannot kill the loop.
   */
  async runLoop(startOffset: number, onUpdate: (update: any) => void, signal: AbortSignal): Promise<void> {
    let offset = startOffset
    while (!signal.aborted) {
      let updates: any[]
      try {
        updates = await this.getUpdates(offset, signal)
      } catch (err) {
        if (signal.aborted) return
        if (isFatalTelegramError(err)) throw err
        const backoff = err instanceof TelegramApiError && err.retryAfterMs ? err.retryAfterMs : this.pollRetryMs
        await sleep(backoff, signal)
        continue
      }
      for (const update of updates) {
        offset = Math.max(offset, Number(update?.update_id ?? offset - 1) + 1)
        try {
          onUpdate(update)
        } catch {
          // a handler failure must not stall the poll loop
        }
      }
    }
  }

  /** Send `text` to `chatId`, splitting over the 4096-unit cap and honoring one
   * 429 retry_after per chunk. Throws on any other failure so the engine's
   * delivery retry can see it. */
  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    for (const chunk of splitForTelegram(text)) {
      try {
        await this.call("sendMessage", { chat_id: chatId, text: chunk }, signal, REQUEST_TIMEOUT_MS)
        continue
      } catch (err) {
        if (!(err instanceof TelegramApiError) || err.retryAfterMs === undefined) throw err
        await sleep(err.retryAfterMs, signal)
      }
      await this.call("sendMessage", { chat_id: chatId, text: chunk }, signal, REQUEST_TIMEOUT_MS)
    }
  }

  private async call(method: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<any> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: withTimeout(signal, timeoutMs),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok || json?.ok === false) {
      throw new TelegramApiError(
        method,
        res.status,
        typeof json?.error_code === "number" ? json.error_code : undefined,
        typeof json?.description === "string" ? json.description : "",
        retryAfterMs(json),
      )
    }
    return json?.result
  }
}

/**
 * The steady-state Telegram platform. Accepts only private-chat messages from
 * the paired `allowFrom` user (others are dropped silently — a bounce would let
 * a stranger probe the policy). The inbound message carries channelID/userID
 * but no sessionKey, so the engine derives `telegram:<chatId>:<userId>` itself,
 * keeping the platform prefix it relies on to restore delivery after a restart.
 */
export class TelegramPlatform implements Platform {
  readonly name = "telegram"
  private readonly poller: TelegramPoller
  private readonly allowFrom: string
  private ac: AbortController | null = null
  private loop: Promise<void> | null = null

  constructor(opts: { token: string; allowFrom: string; baseUrl?: string }) {
    this.poller = new TelegramPoller(opts.token, opts.baseUrl)
    this.allowFrom = opts.allowFrom.trim()
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.ac) return
    const ac = new AbortController()
    this.ac = ac
    // Validate the token up front so a bad credential rejects start() (the
    // gateway turns that into a surfaced failure) instead of looping silently.
    await this.poller.getMe(ac.signal)
    this.loop = this.poller.runLoop(0, (update) => this.dispatch(handler, update), ac.signal)
    try {
      await this.loop
    } finally {
      this.ac = null
      this.loop = null
    }
  }

  private dispatch(handler: MessageHandler, update: unknown): void {
    const msg = inboundMessage(update, this.allowFrom)
    if (msg) handler(this, msg)
  }

  reply(replyCtx: unknown, content: string): Promise<void> {
    return this.poller.sendMessage((replyCtx as { chatId: string }).chatId, content)
  }

  send(replyCtx: unknown, content: string): Promise<void> {
    return this.poller.sendMessage((replyCtx as { chatId: string }).chatId, content)
  }

  async stop(): Promise<void> {
    this.ac?.abort()
    if (this.loop) await this.loop.catch(() => {})
  }

  reconstructReplyCtx(remoteKey: string): { chatId: string } {
    const ctx = parseTelegramRemoteKey(remoteKey)
    if (!ctx) throw new Error(`telegram: cannot reconstruct reply context from "${remoteKey}"`)
    return ctx
  }
}

export interface CapturedSender {
  userId: string
  userName: string
}

/**
 * Pairing primitive: identify who is allowed to drive the bridge by capturing
 * the first private message sent AFTER pairing begins. Used main-only by the
 * connect flow before any `allow_from` exists, so it must run on its OWN poller
 * and the caller must fully await it (including its final ack) before starting
 * the real `TelegramPlatform` — two pollers on one token race a 409.
 *
 * It first drains whatever is already queued (pre-pairing backlog) with an
 * immediate poll so a stale message can't mispair, then long-polls for the
 * first new private text message. On capture it acks that message server-side
 * so the real bridge does not later replay it as a prompt. Returns null if the
 * signal aborts first (the connect dialog was closed). A bad token surfaces as
 * a thrown fatal error; transient failures back off and retry.
 */
export async function captureFirstSender(poller: TelegramPoller, signal: AbortSignal): Promise<CapturedSender | null> {
  let offset = 0
  // Immediate poll: everything queued now is pre-instruction backlog. The next
  // (long) poll at this offset acks it and waits for genuinely new traffic.
  const backlog = await poller.getUpdates(0, signal, 0)
  for (const update of backlog) offset = Math.max(offset, Number(update?.update_id ?? offset - 1) + 1)

  while (!signal.aborted) {
    let updates: any[]
    try {
      updates = await poller.getUpdates(offset, signal)
    } catch (err) {
      if (signal.aborted) return null
      if (isFatalTelegramError(err)) throw err
      const backoff = err instanceof TelegramApiError && err.retryAfterMs ? err.retryAfterMs : poller.pollRetryMs
      await sleep(backoff, signal)
      continue
    }
    for (const update of updates) {
      offset = Math.max(offset, Number(update?.update_id ?? offset - 1) + 1)
      const norm = normalizeUpdate(update)
      if (norm?.isPrivate) {
        // Ack the captured message so the real bridge's fresh poll won't see it.
        await poller.getUpdates(offset, signal, 0).catch(() => [])
        return { userId: norm.userId, userName: norm.userName }
      }
    }
  }
  return null
}

function retryAfterMs(json: any): number | undefined {
  const seconds = Number(json?.parameters?.retry_after)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.min(Math.max(seconds * 1_000, 1_000), 30_000)
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
