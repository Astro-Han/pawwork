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

```text
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
  — each chat gets its own session pointer.
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
failure is isolated: a dead channel reports `degraded` and retries with
exponential backoff while the others keep serving. A clean self-stop (an
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
Feishu/Lark and WeChat adapters land in follow-up PRs; their transport research is
in [#1188](https://github.com/Astro-Han/pawwork/issues/1188).

## Interactive prompts

Permission and question blockers render to **plain text**, answered by typing (a
number / `yes` / `no`, one answer per line for multi-question prompts). `reply` /
`send` are text-only so a new adapter works the moment it can send a string. Native
tap-to-answer controls (e.g. Telegram inline keyboards) are a deferred optimization
([#1188](https://github.com/Astro-Han/pawwork/issues/1188)).
