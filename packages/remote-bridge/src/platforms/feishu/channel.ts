// The seam between the Feishu Platform adapter and the official
// `@larksuiteoapi/node-sdk` long connection. The adapter depends only on this
// interface, so its routing/gating logic stays unit-testable with a fake — the
// real SDK (websocket framing, protobuf, reconnect) is wired in `channel-lark.ts`,
// the one file that imports it. Mirrors how Telegram's adapter talks to a
// `baseUrl`-seamed poller rather than `fetch` directly.

import type { FeishuDomain } from "./registration.ts"

/** An inbound Feishu message, narrowed to the fields the adapter needs. The
 * SDK's richer `NormalizedMessage` is mapped to this in `channel-lark.ts`, so no
 * SDK type leaks past the seam. */
export interface FeishuInbound {
  chatId: string
  chatType: "p2p" | "group"
  senderId: string
  senderName?: string
  messageId: string
  /** Text content; may carry a leading bot @mention, stripped by the adapter. */
  content: string
  /** Whether this message @mentions the bot — the gate for group hygiene. */
  mentionedBot: boolean
}

/** The live Feishu connection the adapter drives. One per connected account. */
export interface FeishuChannel {
  /** Register the inbound-message handler. */
  onMessage(handler: (msg: FeishuInbound) => void): void
  /** Register a channel-level error sink (send failures, transient WS errors). */
  onError(handler: (err: Error) => void): void
  /** Open the long connection; resolves once the first handshake succeeds,
   * rejects if it cannot connect (a bad credential surfaces here). */
  connect(): Promise<void>
  /** Tear the long connection down. */
  disconnect(): Promise<void>
  /** Send `text` to `chatId`, optionally as a threaded reply to `replyTo`. */
  send(chatId: string, text: string, opts?: { replyTo?: string }): Promise<void>
}

export interface FeishuChannelConfig {
  appId: string
  appSecret: string
  /** Which accounts host issued the credentials — selects the SDK endpoint. */
  domain: FeishuDomain
}

/** Builds a live channel from credentials. Injected so the adapter is testable
 * with a fake; production passes `createFeishuChannel` from `channel-lark.ts`. */
export type FeishuChannelFactory = (config: FeishuChannelConfig) => FeishuChannel

/**
 * Strip a leading run of @mentions from message text. A group message that
 * @mentions the bot arrives as "@PawWork do the thing"; the agent should see
 * "do the thing". Safe either way: if the SDK already resolved mentions out of
 * the content, there is no leading @token and this is a no-op.
 */
export function stripLeadingMentions(content: string): string {
  return content.replace(/^\s*(?:@[^\s@]+\s+)+/, "")
}
