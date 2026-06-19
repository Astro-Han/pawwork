// The real per-platform connect logic, behind the runtime's PlatformPairer seam.
// Each pairer is a thin wrapper over the remote-bridge pairing primitives —
// Telegram's captureFirstSender turns a bot token + first message into a saved
// account; WeChat's iLink QR login mints a bot token + the paired user id in one
// scan-and-confirm. New platforms register their pairer in buildRemotePairers below.

import { createApp } from "@opencode-ai/remote-bridge/gateway"
import { captureFirstSender, TelegramPlatform, TelegramPoller } from "@opencode-ai/remote-bridge/platforms/telegram"
import { WeChatClient } from "@opencode-ai/remote-bridge/platforms/wechat/client"
import { pollWeChatLogin, startWeChatLogin } from "@opencode-ai/remote-bridge/platforms/wechat/login"
import { WeChatPlatform } from "@opencode-ai/remote-bridge/platforms/wechat/platform"
import type { Platform } from "@opencode-ai/remote-bridge/types"
import { toDataURL } from "qrcode"
import {
  type PairingProgress,
  type PlatformPairer,
  type RemoteAccount,
  RemoteBridgeRuntime,
  type RemoteBridgeDeps,
} from "./remote-bridge"

// The QR-status poll long-holds ~30s server-side (verified live), so consecutive
// polls already pace themselves; this just guards a fast return from hot-looping.
const WECHAT_LOGIN_POLL_MS = 1_000

class TelegramPairer implements PlatformPairer {
  readonly platform = "telegram" as const

  async pair(start: { token?: string }, emit: PairingProgress, signal: AbortSignal): Promise<RemoteAccount | null> {
    const token = (start.token ?? "").trim()
    if (token === "") throw new Error("a bot token is required")
    const poller = new TelegramPoller(token)
    // capture drains the backlog (proving the token via a fatal 401 if it is bad)
    // before waiting for the first sender, so a message sent during pairing lands
    // past the baseline and is captured, not mistaken for backlog. awaitingBind is
    // emitted from onValidated — only after the token is proven — so a bad token
    // never tells the user to message the bot before it errors.
    let captured: Awaited<ReturnType<typeof captureFirstSender>>
    try {
      captured = await captureFirstSender(poller, signal, () =>
        emit({ phase: "awaitingBind", platform: "telegram", hint: "message" }),
      )
    } catch (err) {
      if (signal.aborted) return null
      throw new Error(`could not reach Telegram with that token: ${message(err)}`)
    }
    if (!captured) return null
    return { platform: "telegram", token, allowFrom: captured.userId, userName: captured.userName }
  }

  makePlatform(account: RemoteAccount): Platform {
    const telegram = asTelegram(account)
    return new TelegramPlatform({ token: telegram.token, allowFrom: telegram.allowFrom })
  }

  audience(account: RemoteAccount): Record<string, unknown> {
    return { allow_from: account.allowFrom }
  }

  identity(account: RemoteAccount): { id: string; name: string } {
    return { id: account.allowFrom, name: account.userName ?? account.allowFrom }
  }
}

class WeChatPairer implements PlatformPairer {
  readonly platform = "wechat" as const

  async pair(_start: { token?: string }, emit: PairingProgress, signal: AbortSignal): Promise<RemoteAccount | null> {
    // QR login mints a bot token, the base URL for all later calls, and the paired
    // user id (ilink_user_id). The scan + confirm in WeChat IS the binding, so there
    // is no separate "message the bot" step — pair resolves straight to the account.
    const client = new WeChatClient()
    let login = await startWeChatLogin({ client, signal })
    emit({ phase: "qr", platform: "wechat", image: await qrDataUrl(login.qrcodeUrl) })
    while (!signal.aborted) {
      const poll = await pollWeChatLogin(login.qrcode, { client, signal })
      if (poll.status === "done") {
        // iLink hands back no display name, only the user id — so we set no userName
        // and identity() falls back to showing the raw id (cosmetic; auth is the id).
        return { platform: "wechat", botToken: poll.botToken, baseURL: poll.baseURL, allowFrom: poll.userId }
      }
      if (poll.status === "error") throw new Error(poll.message)
      if (poll.status === "expired") {
        // The QR lives ~90s; mint a fresh one and show it again rather than dead-end.
        login = await startWeChatLogin({ client, signal })
        emit({ phase: "qr", platform: "wechat", image: await qrDataUrl(login.qrcodeUrl) })
        continue
      }
      await sleep(WECHAT_LOGIN_POLL_MS, signal) // pending
    }
    return null
  }

  makePlatform(account: RemoteAccount): Platform {
    const wechat = asWeChat(account)
    return new WeChatPlatform({
      transport: new WeChatClient({ baseURL: wechat.baseURL, botToken: wechat.botToken }),
      allowFrom: wechat.allowFrom,
    })
  }

  audience(account: RemoteAccount): Record<string, unknown> {
    return { allow_from: account.allowFrom }
  }

  identity(account: RemoteAccount): { id: string; name: string } {
    return { id: account.allowFrom, name: account.userName ?? account.allowFrom }
  }
}

/** Build the production pairers. New platforms add their pairer here. */
export function buildRemotePairers(): PlatformPairer[] {
  return [new TelegramPairer(), new WeChatPairer()]
}

/** Wire a runtime with the real bridge builder and the production pairers. */
export function createRemoteBridgeRuntime(
  deps: Pick<RemoteBridgeDeps, "credentials" | "statePath" | "serverInfo" | "locale">,
): RemoteBridgeRuntime {
  return new RemoteBridgeRuntime({ ...deps, buildApp: createApp, pairers: buildRemotePairers() })
}

/** Render the WeChat login URL into a scannable PNG data URL main-side, so the
 * renderer just shows <img>. iLink's `qrcode_img_content` is a URL, not an image. */
function qrDataUrl(url: string): Promise<string> {
  return toDataURL(url, { margin: 1, width: 232 })
}

function asTelegram(account: RemoteAccount): Extract<RemoteAccount, { platform: "telegram" }> {
  if (account.platform !== "telegram") throw new Error(`expected a telegram account, got ${account.platform}`)
  return account
}

function asWeChat(account: RemoteAccount): Extract<RemoteAccount, { platform: "wechat" }> {
  if (account.platform !== "wechat") throw new Error(`expected a wechat account, got ${account.platform}`)
  return account
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
