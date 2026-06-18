# remote-bridge

Lets a chat app on your phone drive a PawWork agent session — send prompts, read
replies, answer permission/question prompts — with **no relay and no public IP**.
The desktop app holds an outbound connection to each chat platform and talks to
the local PawWork server over HTTP + SSE.

This is the design/model doc. Two companions:

- [`src/platforms/README.md`](./src/platforms/README.md) — the `Platform` adapter
  contract and the conventions every adapter follows. Read it to add a platform.
- Product scope, roadmap, and per-platform transport research live in
  [#1188](https://github.com/Astro-Han/pawwork/issues/1188).

## Shape

```
phone chat app ──outbound──▶ Platform adapter ─┐
                                               ├─▶ Engine ──HTTP+SSE──▶ local PawWork server
phone chat app ──outbound──▶ Platform adapter ─┘
```

- **Platform adapter** (`src/platforms/*`) — one per chat platform. Normalizes
  inbound chat messages to `Message`, delivers assistant text / blockers back out.
- **Engine** (`src/engine.ts`) — platform-agnostic routing: which chat message maps
  to which agent session, and which session's output goes back to which chat.
- **Gateway** (`src/gateway.ts`) — wires the PawWork client, engine, pointers, and
  the enabled platforms into a runnable `App`; owns the event stream and the
  per-platform supervisor.
- **Sidecar** (`src/pawwork-client.ts`) — the local PawWork server, as the engine
  needs it (create session, send prompt, list/answer permissions & questions).

## Routing & concurrency

The model is built so that connecting several channels at once is safe and
unsurprising — no message goes to the wrong place, no channel can flood another.

- **Inbound is isolated per platform.** The engine keys every conversation by a
  platform-scoped **remote key** `<name>:<channelID>:<userID>` (`Engine.remoteKey`).
  Two platforms, or two chats on one platform, are different keys and never collide
  — a Telegram DM and a Feishu group each get their own session pointer.
- **Outbound has a single target per session.** Each agent session delivers to one
  place: the last chat that touched it (`Engine.setActive`, last-writer-wins),
  falling back to the persisted remote key after a restart
  (`pointers.remoteKeyForSession` → the adapter's `reconstructReplyCtx`). The bridge
  **never broadcasts** a session's output to every channel.
- **Concurrency is serialized, not locked.** JS is single-threaded, so interleaved
  inbound messages from many channels are handled one at a time; there is no shared
  mutable state to guard (the Go original used a mutex here).

### Desktop sessions stay silent (Wave 1 decisions)

A session you started on the desktop does **not** mirror to your phone. Concretely:

- **No auto-mirror.** Desktop-originated turns are not pushed to any channel. A
  channel only receives a session it is bound to (you adopted it from the phone via
  `/sessions`, or started it from the phone).
- **No presence gating.** The bridge does not detect whether you're "at the desktop"
  to decide whether to notify. (Considered and cut — KISS.)
- **No handoff command.** There is no `/remote` or hand-this-session-to-my-phone
  command. Discoverability is poor and it adds a verb users must learn; binding a
  channel to a session is done by acting from the phone, nothing to memorize.

The rationale: pushing live desktop activity to the phone is the spammy default
(it buzzes while you're actively working at the desk). Binding output to the
channel that asked for it is the anti-spam mechanism.

## Failure isolation (the supervisor)

`src/supervisor.ts` runs each platform in its own restart loop. One channel's
failure is isolated: a dead Feishu token reports `degraded` and retries with
exponential backoff while Telegram keeps serving. A clean self-stop (an
event-driven adapter that registers its callback and returns) ends that platform's
loop without a restart. Per-platform readiness is deduped, so an adapter that
double-fires `onReady` can't stand in for a platform that hasn't served yet.

The **event stream** is the one fatal path: a dead PawWork server tears the whole
bridge down (nothing works without it). A dead **channel** does not.

There is no per-platform `AbortController`: `Platform` has no start-time signal
(teardown is `stop()`), and Wave 1 disconnects one channel by restarting the whole
bridge, so an independent abort would have no consumer. Isolation comes from the
independent loops, not a per-platform signal. If per-channel stop/restart-on-demand
is ever needed, that's the point to add one.

## Platform connectivity (verified)

Every shipped platform connects **locally, outbound-only** — see the SDK policy and
conventions in the adapter README.

- **Telegram** — Bot API `getUpdates` long-poll + `sendMessage`. Raw `fetch`, no SDK.
  Pairing: capture the first private message after pairing begins
  (`captureFirstSender`).
- **Feishu / Lark** — `@larksuiteoapi/node-sdk` websocket long connection, behind the
  `FeishuChannel` seam (only `platforms/feishu/channel-lark.ts` imports the SDK).
  Pairing is two steps, both **scan-to-connect, no relay, no manual app creation**:
  1. **Device-flow registration** (`registration.ts`): the user scans a QR; Feishu's
     `oauth/v1/app/registration` mints a *PersonalAgent* app and hands its App ID +
     App Secret straight back. Begin always starts on `accounts.feishu.cn` (the
     launcher QR is minted there even for Lark tenants); polling detects a Lark
     tenant via `tenant_brand` and switches to `accounts.larksuite.com`. *Validated
     live against the endpoint (HTTP 200 begin).*
  2. **Chat capture** (`pairing.ts`): connect with the minted credentials and capture
     the first group message that @mentions the bot — its chat id becomes
     `allow_chat`. Unlike Telegram's `getUpdates`, the Feishu long connection does
     not queue events for an offline client, so there is no backlog to drain.

- **WeChat** — Tencent's official **iLink** Bot API (the WeChat ClawBot slot,
  released 2026-03), raw HTTP behind a `baseURL` seam in `platforms/wechat/client.ts`.
  Like Telegram: `getupdates` long-poll + `sendmessage`, no SDK, no public IP, no
  relay we operate (traffic goes through Tencent's `ilinkai.weixin.qq.com`, as
  Telegram goes through `api.telegram.org`). Pairing is scan-to-connect: QR login
  mints a bot token (`login.ts`), then `captureWeChatSender` learns the paired user
  from the first inbound message. iLink is a 1:1 DM, so channelID and userID are the
  same sender id.
  - **No proactive push** is the one structural difference. Every send must echo the
    `context_token` from the inbound message it answers; iLink rejects a send without
    it. The token rides in the reply context and refreshes each user turn, so replies
    (including permission/question prompts) go through while the user is conversing.
    There is no `reconstructReplyCtx` — a target can't be rebuilt from a remote key
    after a restart, so a restored push is logged and skipped. This matches the
    reply-only model above, so the limit is largely moot. Caveats worth knowing:
    regional rollout (mainland + select regions), ~24h re-auth, and a blocker that
    fires long after the user's last message may fail to send until they message again.
  - Verified with three independent research passes (official docs + adversarial +
    OSS source-read). Kun/OpenClaw's older "weixin bridge RPC" was a relay; iLink
    supersedes it as the official local path.

## Interactive prompts

Permission and question blockers render to **plain text**, answered by typing (a
number / `yes` / `no`, one answer per line for multi-question prompts). `reply` /
`send` are text-only so a new adapter works the moment it can send a string. Native
tap-to-answer controls (inline keyboards, Feishu cards) are a deferred optimization
([#1188](https://github.com/Astro-Han/pawwork/issues/1188)).
