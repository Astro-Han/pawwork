# Chat platform adapters

Each file here is one **chat platform adapter** that lets a chat app on your phone
drive a PawWork agent session (send prompts, read replies, answer permission /
question prompts). An adapter implements the `Platform` seam in
[`../types.ts`](../types.ts) so the engine stays decoupled from any one chat SDK.

**[`telegram.ts`](./telegram.ts) is the reference implementation — read it first.**

## The contract

A platform is one object implementing `Platform` (`../types.ts`):

- **`name`** — stable prefix used in the remote key `<name>:<channel>:<user>`.
  Mandatory: the engine routes restored deliveries by `key.split(":")[0]`, so the
  prefix must match the adapter's `name`.
- **`start(handler)`** — open the inbound transport, normalize each inbound message
  to `Message`, and call `handler(this, msg)`. Resolves only when stopped; **reject
  on a fatal error** (bad/revoked credential) so the runtime can surface `degraded`.
- **`reply(replyCtx, content)` / `send(replyCtx, content)`** — answer in-thread /
  push proactively to a restored target.
- **`stop()`** — idempotent teardown.
- **`reconstructReplyCtx?(remoteKey)`** — rebuild a reply target after a restart
  with no live inbound message, so deliveries survive relaunch. Throw if the key is
  unparseable.

Inbound messages are normalized to `Message { content, replyCtx?, channelID?,
userID?, sessionKey? }`. The engine derives the remote key from `name + channelID +
userID` — **do not hand-build session keys.**

Adapters are constructed by the `PlatformFactory` and wired in `createApp`
(`../gateway.ts`). Before a platform starts, **`hasRemoteAudience` refuses a
wildcard/empty audience — closed by default.** Telegram requires `allow_from`;
Feishu/Lark additionally require a named group (`allow_chat` + `group_only`).

## Conventions every adapter must follow

These are the lessons distilled from the most-supported agents (Hermes Agent,
OpenClaw). Follow them or you will ship the bugs they already fixed:

1. **Outbound-only, no public IP.** This is a desktop app behind NAT. Use the
   platform's long-poll / outbound-WebSocket / vendor stream mode. **Never require
   an inbound webhook.** Webhook-only platforms need a hosted relay (see Roadmap).
2. **Dedup by message id.** Long-connections redeliver on reconnect. Keep a
   TTL-bounded seen-set and drop duplicates before dispatching.
3. **Reconnect with exponential backoff + a stall watchdog.** Assume the socket
   drops; force-restart after prolonged silence.
4. **Classify errors.** Fatal (401/403, revoked token) → reject `start()`.
   Transient (429, 5xx, network) → back off and retry.
5. **One credential, one inbound loop.** Never run two loops on the same credential
   concurrently (e.g. Telegram `getUpdates` returns 409). Pairing capture and the
   live bridge hand off via the ack offset; they never overlap.
6. **Credentials stay in the main process** via Electron `safeStorage`. The renderer
   only ever sees masked status — never the token.

## SDK policy

Raw API where the protocol is simple; an **official per-platform SDK only where it
owns the reconnect / long-connection**. Never adopt an all-in-one meta-SDK (Vercel
Chat SDK, `@chat-adapter/*`) — immature and lock-in. Per-adapter SDK deps are fine
(lazy-load heavy ones); `remote-bridge`'s core stays dependency-free.

## Per-platform transport (researched, source-verified)

Every priority platform has a no-public-IP path:

| Platform | Outbound transport | Node path | Onboarding | Official |
|---|---|---|---|---|
| **Telegram** ✅ shipped | `getUpdates` long-poll | raw `fetch` | bot token | yes |
| **Feishu / 飞书** | `WSClient` long-connection | `@larksuiteoapi/node-sdk` | App ID + Secret | yes |
| **WeChat / 微信 (personal)** | Tencent iLink `getupdates` long-poll | raw HTTPS | **QR scan** | ⚠ unofficial |
| **DingTalk / 钉钉** | Stream Mode WS | `@largezhou/ddingtalk` or hand-roll | AppKey + Secret | yes |
| **WeCom / 企业微信** | AI-Bot WS `wss://openws.work.weixin.qq.com` | raw WS | bot id + secret | yes |
| **Discord** | Gateway WS | `discord.js` or raw | bot token | yes |
| **Slack** | Socket Mode WS | `@slack/bolt` | `xoxb-` + `xapp-` | yes |
| **WhatsApp** | Baileys (WhatsApp Web) | `@whiskeysockets/baileys` | **QR scan** | ⚠ unofficial |
| LINE / MS Teams | inbound webhook only | — | — | **needs relay** |

⚠ **WeChat-personal (iLink) and WhatsApp (Baileys) are unofficial** — real
account-ban / ToS risk. Gate behind an experimental flag and disclose to the user.

## Roadmap

- **Wave 1 (next) — Feishu + WeChat.** The Chinese-first priority. Build the
  multi-platform **supervisor** here (per-platform `AbortController`, failure
  isolation so one bad token can't crash the others, backoff restart, dedup).
  Drive it with Feishu first (official SDK, cleanest), then WeChat (iLink + QR pane)
  immediately after.
- **Wave 2 — Discord + Slack.** Western majors; pure adapter adds once the
  supervisor exists.
- **Wave 3 — DingTalk + WeCom.** Chinese enterprise.
- **Wave 4 — WhatsApp.** Western; unofficial (Baileys), QR onboarding.
- **Deferred — LINE, MS Teams.** Webhook-only; require a hosted relay that holds the
  public URL and forwards over the existing outbound channel.

## References

- **Hermes Agent** — `github.com/NousResearch/hermes-agent` (Python, ~26 platforms).
  Best transport reference: `gateway/platforms/{feishu,weixin,dingtalk}.py`.
- **OpenClaw** — `github.com/openclaw/openclaw` (TypeScript). Channel-plugin
  contract + supervisor: `src/channels/plugins/types.plugin.ts`,
  `src/gateway/server-channels.ts`. The `@larksuite/openclaw-lark` package is the
  cleanest end-to-end Feishu-over-WebSocket example.
