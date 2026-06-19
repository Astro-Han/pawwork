// Low-level WeChat iLink Bot API client. iLink is Tencent's official bot channel
// (the WeChat ClawBot slot, bot_type=3): a NAT-friendly HTTP long-poll —
// `getupdates` holds ~35s, `sendmessage` posts a reply. No SDK, no public IP, no
// relay we operate (traffic goes through Tencent's ilinkai servers, exactly as
// Telegram goes through api.telegram.org). Raw fetch with a `baseURL` seam so the
// poll/send logic is unit-tested against a local server, mirroring TelegramPoller.
//
// The one structural difference from Telegram: every outbound message must echo a
// `context_token` lifted from an inbound message (iLink has no proactive push), so
// a reply target is meaningless without a fresh inbound — see the platform adapter.
//
// Wire contract verified against the live service 2026-06-19 (a real bot_type=3
// login + getupdates/sendmessage round-trip); the constants below match what the
// server actually accepts.

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
// iLink identifies the client by an app id + version, sent both as headers
// (iLink-App-Id / iLink-App-ClientVersion) and inside every request's base_info.
// These mirror Tencent's official bot SDK (@tencent-weixin/openclaw-weixin 2.4.4):
// a send that omits them is accepted (ret=0) but silently dropped server-side, so
// they are not optional. Verified against the SDK's wire format and a working client.
const ILINK_APP_ID = "bot"
const ILINK_APP_VERSION = "2.4.4"
// 0x00MMNNPP from the app version: major<<16 | minor<<8 | patch.
const ILINK_APP_CLIENT_VERSION = clientVersion(ILINK_APP_VERSION)
// UA-style "name/version" token carried in base_info; identifies this client.
const BOT_AGENT = "PawWork/1.0.0"
// getupdates holds open up to ~35s server-side; the HTTP timeout must outlast it.
const POLL_TIMEOUT_MS = 45_000
const REQUEST_TIMEOUT_MS = 15_000
// get_qrcode_status ALSO long-polls (~30s server-side, verified live) — it returns
// only when the scan state changes or it times out. A short timeout would abort
// client-side before the server answers, so the poll would never observe a confirm.
const STATUS_POLL_TIMEOUT_MS = 40_000

// iLink message_type / message_state / item type enums (from the bot API spec).
export const MESSAGE_TYPE_USER = 1
// A bot reply is always sent FINISH; iLink has no delivery window, so a reply
// produced minutes after the inbound message still lands (verified against the
// official SDK, which sends FINISH fire-and-forget for multi-minute agent turns).
export const MESSAGE_STATE_FINISH = 2
const MESSAGE_TYPE_BOT = 2
const ITEM_TYPE_TEXT = 1

/** An iLink API call failed. `httpStatus` is the transport status; `ret` is
 * iLink's body-level return code when present (non-zero = error). */
export class WeChatApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly httpStatus: number,
    readonly ret: number | undefined,
    description: string,
  ) {
    super(`wechat ${endpoint} failed: ${httpStatus}${ret !== undefined ? ` (ret ${ret})` : ""} ${description}`.trim())
    this.name = "WeChatApiError"
  }
}

/** A bad/expired bot token can't be fixed by retrying — surface it so the loop
 * rejects start() instead of spinning. 401/403 is the transport signal. */
export function isFatalWeChatError(err: unknown): boolean {
  return err instanceof WeChatApiError && (err.httpStatus === 401 || err.httpStatus === 403)
}

export interface WeChatQrcode {
  /** Opaque handle to poll status with. */
  qrcode: string
  /** A liteapp login URL (NOT an image) — the caller QR-encodes it for the user to
   * scan with WeChat. iLink names the field `qrcode_img_content`, but it carries a
   * URL like https://liteapp.weixin.qq.com/q/...?qrcode=... (verified live). */
  qrcodeUrl: string
}

export type WeChatLoginStatus =
  | { status: "waiting" }
  /** The QR expired before the user confirmed; the caller mints a fresh one. */
  | { status: "expired" }
  /** Confirmed: the bot token + base URL for all later calls, and the paired user
   * id (`ilink_user_id`, which equals the inbound `from_user_id` — verified live). */
  | { status: "confirmed"; botToken: string; baseURL: string; userId: string }

export interface WeChatItem {
  type: number
  text?: string
}

export interface WeChatMessage {
  fromUserId: string
  toUserId: string
  messageType: number
  messageState: number
  contextToken: string
  items: WeChatItem[]
}

export interface WeChatUpdates {
  messages: WeChatMessage[]
  /** Opaque cursor to pass to the next getupdates call. */
  cursor: string
}

/** A per-request UIN header iLink expects: base64 of a random uint32. */
function uin(): string {
  return btoa(String(Math.floor(Math.random() * 0xffffffff)))
}

/** Encode an app version "M.N.P" as the uint32 iLink-App-ClientVersion header wants. */
function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((p) => Number.parseInt(p, 10) || 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

/** The `base_info` block every POST carries. */
function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: ILINK_APP_VERSION, bot_agent: BOT_AGENT }
}

/** A unique client_id for one outbound message; web-crypto when present, else random
 * (the core stays free of node: imports). */
function makeClientId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `wx-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

export class WeChatClient {
  private readonly baseURL: string
  private readonly botToken?: string

  constructor(opts: { baseURL?: string; botToken?: string } = {}) {
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.botToken = opts.botToken
  }

  /** Mint a login QR. No auth — this is the start of pairing. */
  async getBotQrcode(signal?: AbortSignal): Promise<WeChatQrcode> {
    const data = await this.get("/ilink/bot/get_bot_qrcode?bot_type=3", signal, REQUEST_TIMEOUT_MS)
    return { qrcode: str(data, "qrcode"), qrcodeUrl: str(data, "qrcode_img_content") }
  }

  /** Poll whether the user has scanned + confirmed. Long-polls server-side; on
   * confirm returns the bot token, base URL, and paired user id. */
  async getQrcodeStatus(qrcode: string, signal?: AbortSignal): Promise<WeChatLoginStatus> {
    const data = await this.get(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      signal,
      STATUS_POLL_TIMEOUT_MS,
    )
    const status = str(data, "status")
    const botToken = str(data, "bot_token")
    if (status === "confirmed" && botToken !== "") {
      return {
        status: "confirmed",
        botToken,
        baseURL: str(data, "baseurl") || this.baseURL,
        userId: str(data, "ilink_user_id"),
      }
    }
    if (status === "expired") return { status: "expired" }
    return { status: "waiting" }
  }

  /** One long-poll for new messages. `cursor` is empty on the first call, then the
   * value returned by the previous call. Holds open server-side up to ~35s. */
  async getUpdates(cursor: string, signal?: AbortSignal): Promise<WeChatUpdates> {
    const data = await this.post("/ilink/bot/getupdates", { get_updates_buf: cursor }, signal, POLL_TIMEOUT_MS)
    const rawMsgs = Array.isArray(data.msgs) ? data.msgs : []
    const messages = rawMsgs.map(normalizeMessage).filter((m): m is WeChatMessage => m !== null)
    return { messages, cursor: str(data, "get_updates_buf") }
  }

  /**
   * Send one bot reply. Always FINISH with a fresh `client_id`; `contextToken` (lifted
   * from the inbound message) ties it to the conversation — iLink drops a send without
   * it. `from_user_id` is empty: the server fills the bot identity from the token.
   */
  async sendMessage(toUserId: string, contextToken: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.post(
      "/ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: makeClientId(),
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          context_token: contextToken,
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
        },
      },
      signal,
      REQUEST_TIMEOUT_MS,
    )
  }

  /** Tell iLink this bot client is now online (and listening). The official SDK calls
   * this before its first getupdates; without it the server treats the bot as inactive
   * and drops replies after the first. Best-effort: errors are non-fatal. */
  async notifyStart(signal?: AbortSignal): Promise<void> {
    await this.post("/ilink/bot/msg/notifystart", {}, signal, REQUEST_TIMEOUT_MS)
  }

  /** Tell iLink this bot client is going offline (channel stop / shutdown). */
  async notifyStop(signal?: AbortSignal): Promise<void> {
    await this.post("/ilink/bot/msg/notifystop", {}, signal, REQUEST_TIMEOUT_MS)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": uin(),
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    }
    if (this.botToken) headers.Authorization = `Bearer ${this.botToken}`
    return headers
  }

  private async get(path: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
    const res = await fetch(this.baseURL + path, { method: "GET", headers: this.headers(), signal: withTimeout(signal, timeoutMs) })
    return this.parse(path, res)
  }

  private async post(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(this.baseURL + path, {
      method: "POST",
      headers: this.headers(),
      // base_info rides on every POST (the server keys routing/version off it).
      body: JSON.stringify({ ...(body as Record<string, unknown>), base_info: baseInfo() }),
      signal: withTimeout(signal, timeoutMs),
    })
    return this.parse(path, res)
  }

  private async parse(path: string, res: Response): Promise<Record<string, unknown>> {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const ret = typeof data.ret === "number" ? data.ret : undefined
    if (!res.ok || (ret !== undefined && ret !== 0)) {
      throw new WeChatApiError(path.split("?")[0], res.status, ret, str(data, "errmsg") || str(data, "message"))
    }
    return data
  }
}

function normalizeMessage(raw: unknown): WeChatMessage | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as Record<string, unknown>
  const items = Array.isArray(m.item_list)
    ? m.item_list.map((item) => {
        const it = item as Record<string, unknown>
        const textItem = it.text_item as Record<string, unknown> | undefined
        return { type: Number(it.type), text: textItem ? str(textItem, "text") : undefined }
      })
    : []
  return {
    fromUserId: str(m, "from_user_id"),
    toUserId: str(m, "to_user_id"),
    messageType: Number(m.message_type),
    messageState: Number(m.message_state),
    contextToken: str(m, "context_token"),
    items,
  }
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  return typeof value === "string" ? value : ""
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
