// WeChat iLink QR login — the pairing primitive that mints a bot token. The user
// scans the QR with their personal WeChat and confirms; iLink hands back a bot
// token + the base URL to use for all later calls. Parallel to Feishu's
// device-flow registration: scan-to-connect, no developer console, no relay.
//
// Thin wrappers over WeChatClient so the device-flow shape (start → poll-until-done)
// is testable with a fake client, and the live HTTP lives in one place.

import { WeChatClient } from "./client.ts"

export interface WeChatLoginStart {
  /** Opaque handle threaded back to pollWeChatLogin. */
  qrcode: string
  /** Pre-rendered QR image (data URL / base64) to show directly. */
  qrcodeImg: string
}

export type WeChatLoginPoll =
  | { status: "pending" }
  | { status: "done"; botToken: string; baseURL: string }
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
  let qr: { qrcode: string; qrcodeImg: string }
  try {
    qr = await client.getBotQrcode(opts.signal)
  } catch (err) {
    throw new WeChatLoginError(`could not reach WeChat: ${message(err)}`)
  }
  if (qr.qrcode === "") throw new WeChatLoginError("WeChat returned no login QR code")
  return { qrcode: qr.qrcode, qrcodeImg: qr.qrcodeImg }
}

/** Poll once. `pending` until the user confirms in WeChat; `done` carries the bot
 * token + base URL the adapter then connects with. */
export async function pollWeChatLogin(
  qrcode: string,
  opts: { client?: WeChatClient; signal?: AbortSignal } = {},
): Promise<WeChatLoginPoll> {
  const client = opts.client ?? new WeChatClient()
  try {
    const status = await client.getQrcodeStatus(qrcode, opts.signal)
    if (status.status === "confirmed") return { status: "done", botToken: status.botToken, baseURL: status.baseURL }
    return { status: "pending" }
  } catch (err) {
    return { status: "error", message: message(err) }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
