// The one file that imports `@larksuiteoapi/node-sdk`. It wraps the SDK's
// high-level `LarkChannel` (websocket long connection + protobuf framing +
// auto-reconnect, none of which we want to reimplement) behind the `FeishuChannel`
// seam, so the adapter and its tests never load the 26 MB SDK.

import { createLarkChannel, Domain, type NormalizedMessage } from "@larksuiteoapi/node-sdk"
import type { FeishuChannel, FeishuChannelConfig } from "./channel.ts"

/** Build a live Feishu channel backed by the SDK's websocket long connection. */
export function createFeishuChannel(config: FeishuChannelConfig): FeishuChannel {
  const lark = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
    transport: "websocket",
    source: "pawwork",
  })
  return {
    onMessage(handler) {
      lark.on("message", (msg: NormalizedMessage) =>
        handler({
          chatId: msg.chatId,
          chatType: msg.chatType,
          senderId: msg.senderId,
          senderName: msg.senderName,
          messageId: msg.messageId,
          content: msg.content,
          mentionedBot: msg.mentionedBot,
        }),
      )
    },
    onError(handler) {
      lark.on("error", (err) => handler(err))
    },
    connect: () => lark.connect(),
    disconnect: () => lark.disconnect(),
    send: (chatId, text, opts) =>
      lark.send(chatId, { text }, opts?.replyTo ? { replyTo: opts.replyTo } : undefined).then(() => {}),
  }
}
