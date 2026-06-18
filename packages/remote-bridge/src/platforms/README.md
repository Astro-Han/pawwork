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

## Interactive prompts: plain text

Question and permission blockers are rendered to **plain text** and answered by the
user **typing** — a number / `yes` / `no`, and for a multi-question prompt one answer
per line (see `questionPrompt` / `answersForQuestionText` in [`../engine.ts`](../engine.ts)).
`reply` / `send` are deliberately text-only, so a new adapter works the moment it can
send a string.

The cost is a clumsy answer UX: the multi-question hint asks for newline-separated
lines, but on a phone Enter _sends_ the message, so newlines are awkward to type.
Native tap-to-answer controls (Telegram inline keyboards, Feishu cards, Discord
components) are a deferred optimization — design and staging live in
[#1188](https://github.com/Astro-Han/pawwork/issues/1188).

## Conventions every adapter must follow

These are the lessons distilled from the most-supported agents (Hermes Agent,
OpenClaw). Follow them or you will ship the bugs they already fixed:

1. **Outbound-only, no public IP.** This is a desktop app behind NAT. Use the
   platform's long-poll / outbound-WebSocket / vendor stream mode. **Never require
   an inbound webhook.** Webhook-only platforms need a hosted relay (tracked in #1188).
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

## Planned platforms

Telegram ships here. The rollout order for the platforms after it (Feishu, WeChat,
Discord, Slack, DingTalk, WeCom, WhatsApp), the source-verified outbound-only
transport for each (every priority platform has a no-public-IP path), and the external
references (Hermes Agent, OpenClaw, Tencent iLink) live in
[#1188](https://github.com/Astro-Han/pawwork/issues/1188). Adding a platform is a pure
adapter against the contract above — no engine change.
