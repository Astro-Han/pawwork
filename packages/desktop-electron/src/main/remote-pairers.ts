// The real per-platform connect logic, behind the runtime's PlatformPairer seam.
// This is the one desktop-side file that loads the Lark SDK (via createFeishuChannel),
// so the runtime and its tests stay SDK-free. Each pairer is a thin wrapper over the
// remote-bridge pairing primitives — Telegram's captureFirstSender, Feishu's
// device-flow registration + chat capture, WeChat's iLink QR login + sender capture
// — turning a scan/paste into a saved account, and a saved account into a live Platform.

import { createApp } from "@opencode-ai/remote-bridge/gateway"
import type { FeishuChannelFactory } from "@opencode-ai/remote-bridge/platforms/feishu/channel"
import { createFeishuChannel } from "@opencode-ai/remote-bridge/platforms/feishu/channel-lark"
import { captureFeishuChat } from "@opencode-ai/remote-bridge/platforms/feishu/pairing"
import { FeishuPlatform } from "@opencode-ai/remote-bridge/platforms/feishu/platform"
import {
  type FeishuDomain,
  pollFeishuRegistration,
  startFeishuRegistration,
} from "@opencode-ai/remote-bridge/platforms/feishu/registration"
import { captureFirstSender, TelegramPlatform, TelegramPoller } from "@opencode-ai/remote-bridge/platforms/telegram"
import { WeChatClient } from "@opencode-ai/remote-bridge/platforms/wechat/client"
import { pollWeChatLogin, startWeChatLogin } from "@opencode-ai/remote-bridge/platforms/wechat/login"
import { captureWeChatSender, WeChatPlatform } from "@opencode-ai/remote-bridge/platforms/wechat/platform"
import type { Platform } from "@opencode-ai/remote-bridge/types"
import { toDataURL } from "qrcode"
import {
  type PairingProgress,
  type PlatformPairer,
  type RemoteAccount,
  RemoteBridgeRuntime,
  type RemoteBridgeDeps,
} from "./remote-bridge"

// WeChat's QR-status poll has no server-side long-hold (unlike getupdates), so we
// pace it from the client.
const WECHAT_LOGIN_POLL_MS = 2_000

class TelegramPairer implements PlatformPairer {
  readonly platform = "telegram" as const

  async pair(start: { token?: string }, emit: PairingProgress, signal: AbortSignal): Promise<RemoteAccount | null> {
    const token = (start.token ?? "").trim()
    if (token === "") throw new Error("a bot token is required")
    const poller = new TelegramPoller(token)
    emit({ phase: "awaitingBind", platform: "telegram", hint: "message" })
    // capture drains the backlog (proving the token via a fatal 401 if it is bad)
    // before waiting for the first sender, so a message sent during pairing lands
    // past the baseline and is captured, not mistaken for backlog.
    let captured: Awaited<ReturnType<typeof captureFirstSender>>
    try {
      captured = await captureFirstSender(poller, signal)
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
    return { allow_from: asTelegram(account).allowFrom }
  }

  identity(account: RemoteAccount): { id: string; name: string } {
    const telegram = asTelegram(account)
    return { id: telegram.allowFrom, name: telegram.userName ?? telegram.allowFrom }
  }
}

class FeishuPairer implements PlatformPairer {
  readonly platform = "feishu" as const

  constructor(private readonly createChannel: FeishuChannelFactory) {}

  async pair(_start: unknown, emit: PairingProgress, signal: AbortSignal): Promise<RemoteAccount | null> {
    // Step 1 — device-flow registration: the user scans the launcher QR and Feishu
    // mints a PersonalAgent app, handing its App ID + Secret straight back.
    const registration = await startFeishuRegistration()
    // Feishu hands back a launcher URL, not a QR image (WeChat returns one ready);
    // render it main-side so the renderer just shows <img> for both. If rendering
    // fails the renderer falls back to the url + code carried alongside.
    const image = await toDataURL(registration.verificationUri, { margin: 1, width: 232 }).catch(() => undefined)
    emit({ phase: "qr", platform: "feishu", image, url: registration.verificationUri, code: registration.userCode || undefined })
    const deadline = Date.now() + registration.expiresInMs
    let domain: FeishuDomain = registration.domain
    let credentials: { appId: string; appSecret: string; domain: FeishuDomain } | null = null
    while (!signal.aborted) {
      await sleep(registration.intervalMs, signal)
      if (signal.aborted) return null
      const poll = await pollFeishuRegistration(registration.deviceCode, domain)
      if (poll.status === "pending") {
        domain = poll.domain // may have switched feishu → lark
        if (Date.now() > deadline) throw new Error("Feishu pairing timed out — please try again")
        continue
      }
      if (poll.status === "error") throw new Error(poll.message)
      credentials = { appId: poll.appId, appSecret: poll.appSecret, domain: poll.domain }
      break
    }
    if (!credentials) return null
    // Step 2 — chat capture: connect with the minted credentials and learn which
    // group to serve from the first message that @mentions the bot.
    const channel = this.createChannel(credentials)
    emit({ phase: "awaitingBind", platform: "feishu", hint: "group" })
    try {
      const chat = await captureFeishuChat(channel, signal)
      if (!chat) return null
      return { platform: "feishu", appId: credentials.appId, appSecret: credentials.appSecret, domain: credentials.domain, allowChat: chat.chatId }
    } finally {
      // The live bridge opens its own connection; this pairing one must close so a
      // single PersonalAgent app never holds two long connections at once.
      await channel.disconnect().catch(() => {})
    }
  }

  makePlatform(account: RemoteAccount): Platform {
    const feishu = asFeishu(account)
    return new FeishuPlatform({
      appId: feishu.appId,
      appSecret: feishu.appSecret,
      domain: feishu.domain,
      allowChat: feishu.allowChat,
      createChannel: this.createChannel,
    })
  }

  audience(account: RemoteAccount): Record<string, unknown> {
    return { allow_chat: asFeishu(account).allowChat, group_only: true }
  }

  identity(account: RemoteAccount): { id: string; name: string } {
    const feishu = asFeishu(account)
    return { id: feishu.allowChat, name: feishu.chatName ?? feishu.allowChat }
  }
}

class WeChatPairer implements PlatformPairer {
  readonly platform = "wechat" as const

  async pair(_start: unknown, emit: PairingProgress, signal: AbortSignal): Promise<RemoteAccount | null> {
    // Step 1 — QR login mints a bot token + the base URL for all later calls.
    const client = new WeChatClient()
    const login = await startWeChatLogin({ client, signal })
    emit({ phase: "qr", platform: "wechat", image: login.qrcodeImg })
    let credentials: { botToken: string; baseURL: string } | null = null
    while (!signal.aborted) {
      await sleep(WECHAT_LOGIN_POLL_MS, signal)
      if (signal.aborted) return null
      const poll = await pollWeChatLogin(login.qrcode, { client, signal })
      if (poll.status === "pending") continue
      if (poll.status === "error") throw new Error(poll.message)
      credentials = { botToken: poll.botToken, baseURL: poll.baseURL }
      break
    }
    if (!credentials) return null
    // Step 2 — learn the paired user from the first inbound message on the new token.
    const authed = new WeChatClient({ baseURL: credentials.baseURL, botToken: credentials.botToken })
    emit({ phase: "awaitingBind", platform: "wechat", hint: "message" })
    const userId = await captureWeChatSender(authed, signal)
    if (!userId) return null
    return { platform: "wechat", botToken: credentials.botToken, baseURL: credentials.baseURL, allowFrom: userId }
  }

  makePlatform(account: RemoteAccount): Platform {
    const wechat = asWeChat(account)
    return new WeChatPlatform({
      transport: new WeChatClient({ baseURL: wechat.baseURL, botToken: wechat.botToken }),
      allowFrom: wechat.allowFrom,
    })
  }

  audience(account: RemoteAccount): Record<string, unknown> {
    return { allow_from: asWeChat(account).allowFrom }
  }

  identity(account: RemoteAccount): { id: string; name: string } {
    const wechat = asWeChat(account)
    return { id: wechat.allowFrom, name: wechat.userName ?? wechat.allowFrom }
  }
}

/** Build the production pairers. The Feishu pairer gets the SDK-backed channel. */
export function buildRemotePairers(): PlatformPairer[] {
  return [new TelegramPairer(), new FeishuPairer(createFeishuChannel), new WeChatPairer()]
}

/** Wire a runtime with the real bridge builder and the production pairers. */
export function createRemoteBridgeRuntime(
  deps: Pick<RemoteBridgeDeps, "credentials" | "statePath" | "serverInfo" | "locale">,
): RemoteBridgeRuntime {
  return new RemoteBridgeRuntime({ ...deps, buildApp: createApp, pairers: buildRemotePairers() })
}

function asTelegram(account: RemoteAccount): Extract<RemoteAccount, { platform: "telegram" }> {
  if (account.platform !== "telegram") throw new Error(`expected a telegram account, got ${account.platform}`)
  return account
}

function asFeishu(account: RemoteAccount): Extract<RemoteAccount, { platform: "feishu" }> {
  if (account.platform !== "feishu") throw new Error(`expected a feishu account, got ${account.platform}`)
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
