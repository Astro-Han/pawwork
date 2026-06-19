// WeChat iLink QR login — the pairing primitive that mints a bot token. The user
// scans the QR with their personal WeChat and confirms ("将 OpenClaw 连接到微信");
// iLink hands back a bot token, the base URL for all later calls, and the paired
// user id. Verified live 2026-06-19: the confirm response carries `ilink_user_id`,
// which equals the inbound `from_user_id`, so pairing is one step — the scan+confirm
// IS the binding, no separate "message the bot" round-trip needed.
//
// Thin wrappers over WeChatClient so the device-flow shape (start → poll-until-done)
// is testable with a fake client, and the live HTTP lives in one place.

import { WeChatApiError, WeChatClient } from "./client.ts"

export interface WeChatLoginStart {
  /** Opaque handle threaded back to pollWeChatLogin. */
  qrcode: string
  /** A liteapp login URL to QR-encode for the user to scan (not an image itself). */
  qrcodeUrl: string
}

export type WeChatLoginPoll =
  | { status: "pending" }
  /** The QR expired before confirmation; mint a fresh one and show it again. */
  | { status: "expired" }
  | { status: "done"; botToken: string; baseURL: string; userId: string }
  | { status: "error"; message: string }

/** A login call failed before a bot token could be minted. */
export class WeChatLoginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WeChatLoginError"
  }
}

/** Begin login: fetch the QR to render. */
export async function startWeChatLogin(
  opts: { client?: WeChatClient; signal?: AbortSignal } = {},
): Promise<WeChatLoginStart> {
  const client = opts.client ?? new WeChatClient()
  let qr: { qrcode: string; qrcodeUrl: string }
  try {
    qr = await client.getBotQrcode(opts.signal)
  } catch (err) {
    throw new WeChatLoginError(`could not reach WeChat: ${message(err)}`)
  }
  if (qr.qrcode === "" || qr.qrcodeUrl === "") throw new WeChatLoginError("WeChat returned no login QR code")
  return { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl }
}

/** Poll once. `pending` until the user confirms in WeChat; `done` carries the bot
 * token, base URL, and paired user id the adapter then connects with. */
export async function pollWeChatLogin(
  qrcode: string,
  opts: { client?: WeChatClient; signal?: AbortSignal } = {},
): Promise<WeChatLoginPoll> {
  const client = opts.client ?? new WeChatClient()
  try {
    const status = await client.getQrcodeStatus(qrcode, opts.signal)
    if (status.status === "confirmed") {
      return { status: "done", botToken: status.botToken, baseURL: status.baseURL, userId: status.userId }
    }
    if (status.status === "expired") return { status: "expired" }
    return { status: "pending" }
  } catch (err) {
    // The status call long-polls (~30s); a client-side timeout or transient network
    // blip is expected — keep waiting. A real server-side API error (5xx / bad ret)
    // is surfaced so the user isn't left spinning on a dead QR.
    if (opts.signal?.aborted) return { status: "pending" }
    if (err instanceof WeChatApiError) return { status: "error", message: err.message }
    return { status: "pending" }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
