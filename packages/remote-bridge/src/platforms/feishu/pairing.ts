// The second half of Feishu pairing. `registration.ts` mints the App ID/Secret
// from a QR scan; this learns which group the bot should serve by connecting the
// freshly-minted channel and capturing the first group message that @mentions the
// bot. Its chat id becomes `allow_chat`. Parallel to Telegram's captureFirstSender:
// pairing runs on its own channel and the caller tears it down before starting the
// real bridge, so one PersonalAgent app never holds two long connections at once.

import type { FeishuChannel } from "./channel.ts"

export interface FeishuPairedChat {
  chatId: string
}

/**
 * Connect `channel` and resolve with the first group chat that @mentions the
 * bot — the group the user just added it to. Returns null if `signal` aborts
 * (the connect dialog was closed) before a message arrives. `connect()` rejects
 * on a bad credential, which propagates so the caller can surface it. The handler
 * is registered before connect so an early message is never missed.
 */
export async function captureFeishuChat(channel: FeishuChannel, signal: AbortSignal): Promise<FeishuPairedChat | null> {
  if (signal.aborted) return null
  const captured = new Promise<FeishuPairedChat | null>((resolve) => {
    channel.onMessage((msg) => {
      if (msg.chatType === "group" && msg.mentionedBot) resolve({ chatId: msg.chatId })
    })
    signal.addEventListener("abort", () => resolve(null), { once: true })
  })
  await channel.connect()
  if (signal.aborted) return null
  return captured
}
