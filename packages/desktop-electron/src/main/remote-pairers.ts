// The real per-platform connect logic, behind the runtime's PlatformPairer seam.
// Each pairer is a thin wrapper over the remote-bridge pairing primitives —
// Telegram's captureFirstSender turns a bot token + first message into a saved
// account, and a saved account into a live Platform. New platforms register their
// pairer in buildRemotePairers below.

import { createApp } from "@opencode-ai/remote-bridge/gateway"
import { captureFirstSender, TelegramPlatform, TelegramPoller } from "@opencode-ai/remote-bridge/platforms/telegram"
import type { Platform } from "@opencode-ai/remote-bridge/types"
import {
  type PairingProgress,
  type PlatformPairer,
  type RemoteAccount,
  RemoteBridgeRuntime,
  type RemoteBridgeDeps,
} from "./remote-bridge"

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
    return new TelegramPlatform({ token: account.token, allowFrom: account.allowFrom })
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
  return [new TelegramPairer()]
}

/** Wire a runtime with the real bridge builder and the production pairers. */
export function createRemoteBridgeRuntime(
  deps: Pick<RemoteBridgeDeps, "credentials" | "statePath" | "serverInfo" | "locale">,
): RemoteBridgeRuntime {
  return new RemoteBridgeRuntime({ ...deps, buildApp: createApp, pairers: buildRemotePairers() })
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
