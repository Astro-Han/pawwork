import { expect, test } from "bun:test"
import { PartialDeliveryError, type MessageHandler, type Platform } from "../types.ts"
import {
  captureFirstSender,
  inboundMessage,
  isFatalTelegramError,
  MAX_CONFLICT_RETRIES,
  normalizeUpdate,
  parseTelegramRemoteKey,
  splitForTelegram,
  TelegramApiError,
  TelegramPlatform,
  TelegramPoller,
} from "./telegram.ts"

// --- pure helpers ----------------------------------------------------------

test("splitForTelegram returns short text untouched, with no header", () => {
  expect(splitForTelegram("hello")).toEqual(["hello"])
})

test("splitForTelegram splits over the 4096-unit cap and headers each piece", () => {
  const long = "a".repeat(9000)
  const chunks = splitForTelegram(long)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[0].startsWith(`[1/${chunks.length}]\n`)).toBe(true)
  // Each chunk's UTF-16 length stays within Telegram's cap.
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096)
  // Reassembling the bodies (minus headers) restores the original text.
  const body = chunks.map((c) => c.replace(/^\[\d+\/\d+\]\n/, "")).join("")
  expect(body).toBe(long)
})

test("splitForTelegram preserves a newline that falls on a split boundary", () => {
  // Long enough to split, with a newline in the last 10% of the first chunk so
  // the line-boundary break fires. The delimiter must survive: stripping headers
  // and concatenating the bodies must reproduce the original exactly.
  const text = "a".repeat(3980) + "\n" + "b".repeat(4000)
  const chunks = splitForTelegram(text)
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096)
  const body = chunks.map((c) => c.replace(/^\[\d+\/\d+\]\n/, "")).join("")
  expect(body).toBe(text)
})

test("splitForTelegram never splits a surrogate pair", () => {
  const emoji = "😀".repeat(3000) // each emoji is 2 UTF-16 units
  const chunks = splitForTelegram(emoji)
  for (const chunk of chunks) {
    const body = chunk.replace(/^\[\d+\/\d+\]\n/, "")
    // A split surrogate would leave a lone code unit (\uD83D or \uDE00).
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(body)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)).toBe(false)
  }
})

test("parseTelegramRemoteKey extracts chatId; rejects other shapes", () => {
  expect(parseTelegramRemoteKey("telegram:123:456")).toEqual({ chatId: "123" })
  expect(parseTelegramRemoteKey("slack:123:456")).toBeNull()
  expect(parseTelegramRemoteKey("telegram:")).toBeNull()
  expect(parseTelegramRemoteKey("telegram::456")).toBeNull()
})

test("normalizeUpdate maps a private text message and skips non-text/empty", () => {
  const ok = normalizeUpdate({ update_id: 7, message: { text: "hi", from: { id: 9, username: "yu" }, chat: { id: 5, type: "private" } } })
  expect(ok).toEqual({ updateId: 7, chatId: "5", userId: "9", userName: "yu", text: "hi", isPrivate: true })
  expect(normalizeUpdate({ update_id: 8, message: { from: { id: 9 }, chat: { id: 5, type: "private" } } })).toBeNull()
  expect(normalizeUpdate({ update_id: 8, message: { text: "   ", from: { id: 9 }, chat: { id: 5, type: "private" } } })).toBeNull()
  expect(normalizeUpdate({})).toBeNull()
})

test("inboundMessage enforces private-chat + allowlist as silent drops", () => {
  const allowed = { update_id: 1, message: { text: "go", from: { id: 42 }, chat: { id: 100, type: "private" } } }
  const stranger = { update_id: 2, message: { text: "go", from: { id: 99 }, chat: { id: 100, type: "private" } } }
  const group = { update_id: 3, message: { text: "go", from: { id: 42 }, chat: { id: -100, type: "group" } } }

  expect(inboundMessage(allowed, "42")).toEqual({
    content: "go",
    replyCtx: { chatId: "100" },
    channelID: "100",
    userID: "42",
  })
  expect(inboundMessage(stranger, "42")).toBeNull()
  expect(inboundMessage(group, "42")).toBeNull()
  // An empty allowFrom (pairing capture only) accepts any private sender.
  expect(inboundMessage(stranger, "")).not.toBeNull()
})

test("isFatalTelegramError treats auth/not-found as fatal, others transient", () => {
  expect(isFatalTelegramError(new TelegramApiError("getUpdates", 401, 401, "Unauthorized", undefined))).toBe(true)
  expect(isFatalTelegramError(new TelegramApiError("getUpdates", 403, 403, "Forbidden", undefined))).toBe(true)
  expect(isFatalTelegramError(new TelegramApiError("getUpdates", 409, 409, "Conflict", undefined))).toBe(false)
  expect(isFatalTelegramError(new TelegramApiError("getUpdates", 429, 429, "Too Many", 2000))).toBe(false)
  expect(isFatalTelegramError(new Error("network"))).toBe(false)
})

// --- against a local fake Bot API ------------------------------------------

interface FakeCall {
  method: string
  body: any
}

/**
 * A local stand-in for api.telegram.org. `getUpdates` drains a queued list of
 * batches (one per call), then long-returns empty so the loop idles. Records
 * every call so tests can assert the offset handoff and send payloads.
 */
function fakeBotApi(batches: any[][]) {
  const calls: FakeCall[] = []
  let batchIndex = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const method = url.pathname.split("/").pop() ?? ""
      const body = await req.json().catch(() => ({}))
      calls.push({ method, body })
      if (method === "getMe") return json({ ok: true, result: { id: 1, username: "bot", first_name: "Bot" } })
      if (method === "getUpdates") {
        const batch = batchIndex < batches.length ? batches[batchIndex++] : []
        return json({ ok: true, result: batch })
      }
      if (method === "sendMessage") return json({ ok: true, result: { message_id: 1 } })
      return json({ ok: true, result: {} })
    },
  })
  return { url: `http://localhost:${server.port}`, calls, stop: () => server.stop(true) }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

function update(id: number, userId: number, text = "hi") {
  return { update_id: id, message: { text, from: { id: userId, username: `u${userId}` }, chat: { id: userId, type: "private" } } }
}

function groupUpdate(id: number, userId: number, text = "hi") {
  return { update_id: id, message: { text, from: { id: userId, username: `u${userId}` }, chat: { id: -id, type: "group" } } }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition")
    await new Promise((r) => setTimeout(r, 5))
  }
}

test("runLoop advances the offset past the highest update_id it received", async () => {
  const api = fakeBotApi([[update(10, 42), update(11, 42)]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const ac = new AbortController()
    const loop = poller.runLoop(0, () => {}, ac.signal)
    // First getUpdates uses offset 0; the next must ack with maxUpdateId + 1.
    await waitFor(() => api.calls.filter((c) => c.method === "getUpdates").length >= 2)
    ac.abort()
    await loop
    const offsets = api.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(12)
  } finally {
    api.stop()
  }
})

test("runLoop ignores a malformed update_id instead of poisoning the offset with NaN", async () => {
  // A good update (id 10) then one with a non-numeric update_id. The offset must
  // advance to 11 and stay finite — a NaN offset would make every later poll
  // request offset=NaN (serialized to null) and replay the whole backlog.
  const malformed = { update_id: "oops", message: { text: "x", from: { id: 42 }, chat: { id: 42, type: "private" } } }
  const api = fakeBotApi([[update(10, 42)], [malformed]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const ac = new AbortController()
    const loop = poller.runLoop(0, () => {}, ac.signal)
    await waitFor(() => api.calls.filter((c) => c.method === "getUpdates").length >= 3)
    ac.abort()
    await loop
    const offsets = api.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(11) // acked the good update 10
    expect(offsets[2]).toBe(11) // malformed id skipped, offset held — not NaN
    expect(offsets.every((o) => Number.isFinite(o))).toBe(true)
  } finally {
    api.stop()
  }
})

test("TelegramPlatform delivers only the paired user's private messages", async () => {
  // Batch 0 (empty) ends the start-up drain; the live poll then returns the owner
  // and a stranger, and only the owner's private message is delivered.
  const api = fakeBotApi([[], [update(1, 42, "from owner"), update(2, 99, "from stranger")]])
  try {
    const platform = new TelegramPlatform({ token: "t", allowFrom: "42", baseUrl: api.url })
    const received: { platform: Platform; content: string; channelID?: string }[] = []
    const handler: MessageHandler = (p, m) => received.push({ platform: p, content: m.content, channelID: m.channelID })
    const run = platform.start(handler)
    await waitFor(() => received.length >= 1)
    await platform.stop()
    await run
    expect(received).toHaveLength(1)
    expect(received[0].content).toBe("from owner")
    expect(received[0].channelID).toBe("42")
  } finally {
    api.stop()
  }
})

test("TelegramPlatform drops the backlog on start so a queued prompt is not replayed", async () => {
  // update 5 is already queued when the platform starts (a prompt sent while the
  // app was down, or one left unacked when it crashed). The start-up drain must
  // ack past it WITHOUT dispatching it; only the genuinely new message (update 6,
  // after the empty drain poll) is delivered.
  const api = fakeBotApi([[update(5, 42, "stale offline prompt")], [], [update(6, 42, "new prompt")]])
  try {
    const platform = new TelegramPlatform({ token: "t", allowFrom: "42", baseUrl: api.url })
    const received: string[] = []
    const handler: MessageHandler = (_p, m) => received.push(m.content)
    const run = platform.start(handler)
    await waitFor(() => received.length >= 1)
    await platform.stop()
    await run
    expect(received).toEqual(["new prompt"])
    // The drain started at offset 0 and acked the stale backlog (max id 5) at
    // offset 6 before the live poll began.
    const offsets = api.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(6)
  } finally {
    api.stop()
  }
})

test("start() signals onReady only after the first live poll returns, past the backlog drain", async () => {
  // The startup-race guard: onReady must not fire until the drain is done AND the
  // first live getUpdates has actually returned, so a caller can't report
  // "connected" while a freshly sent message would still be swept away as backlog
  // (or while a 409 keeps the live loop from ever serving). update 5 is the stale
  // backlog; the empty batch ends the drain; update 6 is the first live message.
  const api = fakeBotApi([[update(5, 42, "stale")], [], [update(6, 42, "new")]])
  try {
    const platform = new TelegramPlatform({ token: "t", allowFrom: "42", baseUrl: api.url })
    let readyCalls = 0
    let getUpdatesAtReady = -1
    const run = platform.start(
      () => {},
      () => {
        readyCalls++
        getUpdatesAtReady = api.calls.filter((c) => c.method === "getUpdates").length
      },
    )
    await waitFor(() => readyCalls > 0)
    await platform.stop()
    await run
    expect(readyCalls).toBe(1)
    // Two drain polls (the stale batch, then the empty terminator) and then the
    // first live poll that returned update 6: onReady fires only on that third
    // poll's return, never during the drain and never on mere loop install.
    expect(getUpdatesAtReady).toBeGreaterThanOrEqual(3)
  } finally {
    api.stop()
  }
})

test("runLoop gives up after bounded 409 conflicts and never signals ready", async () => {
  // Every getUpdates returns 409 — another client is long-polling this token, so
  // the loop will NEVER receive anything. It must not spin forever (which would
  // leave the desktop showing a healthy-looking "connecting"): after a bounded
  // number of retries it rejects, and onReady never fires, so the runtime lands
  // on "degraded" with a real cause. The test resolving at all proves the retry
  // is bounded — an unbounded loop against this server would hang to timeout.
  let polls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop() ?? ""
      if (method !== "getUpdates") return json({ ok: true, result: {} })
      polls++
      return json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" })
    },
  })
  try {
    const poller = new TelegramPoller("t", `http://localhost:${server.port}`)
    poller.pollRetryMs = 0
    let ready = 0
    await expect(poller.runLoop(0, () => {}, new AbortController().signal, () => ready++)).rejects.toThrow(
      /another client is polling this bot token/i,
    )
    expect(ready).toBe(0)
    // MAX_CONFLICT_RETRIES retries are tolerated; the next conflict throws.
    expect(polls).toBe(MAX_CONFLICT_RETRIES + 1)
  } finally {
    server.stop(true)
  }
})

test("runLoop signals ready only after the first poll that returns, surviving a transient 409", async () => {
  // The first two live polls 409 (a brief handoff — our own previous poller still
  // releasing on reconnect), then it clears. onReady must NOT fire during the
  // conflict: only after the first getUpdates that actually returns, and exactly
  // once. The conflict counter resets on that success, so a later blip is tolerated.
  let polls = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop() ?? ""
      if (method !== "getUpdates") return json({ ok: true, result: {} })
      polls++
      if (polls <= 2) return json({ ok: false, error_code: 409, description: "Conflict" })
      return json({ ok: true, result: [] }) // conflict cleared: an empty live poll
    },
  })
  try {
    const poller = new TelegramPoller("t", `http://localhost:${server.port}`)
    poller.pollRetryMs = 0
    const ac = new AbortController()
    let ready = 0
    let pollsAtReady = -1
    const loop = poller.runLoop(0, () => {}, ac.signal, () => {
      ready++
      pollsAtReady = polls
    })
    await waitFor(() => ready > 0)
    ac.abort()
    await loop
    expect(ready).toBe(1)
    // The two 409s plus the first poll that returned: ready fires on the 3rd poll,
    // never during the retries.
    expect(pollsAtReady).toBe(3)
  } finally {
    server.stop(true)
  }
})

test("TelegramPlatform.send splits a long reply into multiple sendMessage calls", async () => {
  const api = fakeBotApi([])
  try {
    const platform = new TelegramPlatform({ token: "t", allowFrom: "42", baseUrl: api.url })
    await platform.reply({ chatId: "100" }, "a".repeat(9000))
    const sends = api.calls.filter((c) => c.method === "sendMessage")
    expect(sends.length).toBeGreaterThan(1)
    expect(sends.every((c) => c.body.chat_id === "100")).toBe(true)
  } finally {
    api.stop()
  }
})

test("sendMessage retries a transient per-chunk failure in place, never resending earlier chunks", async () => {
  // A long reply → 3 chunks. The 2nd chunk's first send fails transiently (500),
  // then succeeds. The retry is in place: chunk 1 is delivered exactly once and
  // the user ends up with one complete, ordered set — no duplicated head.
  const delivered: string[] = []
  let chunk2Attempts = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop() ?? ""
      if (method !== "sendMessage") return json({ ok: true, result: {} })
      const body: any = await req.json().catch(() => ({}))
      const header = String(body.text ?? "").match(/^\[(\d+)\/(\d+)\]/)
      const idx = header ? Number(header[1]) : 1
      if (idx === 2) {
        chunk2Attempts++
        if (chunk2Attempts === 1) return json({ ok: false, error_code: 500, description: "transient" })
      }
      delivered.push(header ? header[0] : "")
      return json({ ok: true, result: { message_id: 1 } })
    },
  })
  try {
    const poller = new TelegramPoller("t", `http://localhost:${server.port}`)
    poller.pollRetryMs = 0
    await poller.sendMessage("100", "a".repeat(9000))
    expect(delivered).toEqual(["[1/3]", "[2/3]", "[3/3]"])
    expect(chunk2Attempts).toBe(2) // failed once, retried once in place
  } finally {
    server.stop(true)
  }
})

test("sendMessage throws PartialDeliveryError when a later chunk fails for good, without resending the head", async () => {
  // The 2nd chunk fails permanently. Chunk 1 was already delivered, so a wholesale
  // resend would duplicate it — sendMessage surfaces PartialDeliveryError instead,
  // which the engine's delivery retry treats as terminal.
  const delivered: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop() ?? ""
      if (method !== "sendMessage") return json({ ok: true, result: {} })
      const body: any = await req.json().catch(() => ({}))
      const header = String(body.text ?? "").match(/^\[(\d+)\/(\d+)\]/)
      const idx = header ? Number(header[1]) : 1
      if (idx >= 2) return json({ ok: false, error_code: 500, description: "down" })
      delivered.push(header ? header[0] : "")
      return json({ ok: true, result: { message_id: 1 } })
    },
  })
  try {
    const poller = new TelegramPoller("t", `http://localhost:${server.port}`)
    poller.pollRetryMs = 0
    await expect(poller.sendMessage("100", "a".repeat(9000))).rejects.toBeInstanceOf(PartialDeliveryError)
    expect(delivered).toEqual(["[1/3]"]) // head delivered once despite the in-place retries on chunk 2
  } finally {
    server.stop(true)
  }
})

test("reconstructReplyCtx rebuilds chatId from a stored remote key; throws otherwise", () => {
  const platform = new TelegramPlatform({ token: "t", allowFrom: "42" })
  expect(platform.reconstructReplyCtx("telegram:100:42")).toEqual({ chatId: "100" })
  expect(() => platform.reconstructReplyCtx("nope")).toThrow()
})

// --- pairing capture -------------------------------------------------------

test("captureFirstSender drains backlog and returns the first NEW private sender", async () => {
  // Batch 0 is pre-pairing backlog from user 7; the empty batch 1 marks the
  // backlog as fully drained, then the long-poll delivers a genuinely new
  // message from user 42.
  const api = fakeBotApi([[update(5, 7, "stale")], [], [update(10, 42, "pair me")]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const captured = await captureFirstSender(poller, new AbortController().signal)
    expect(captured).toEqual({ userId: "42", userName: "u42", botUsername: "bot" })
    // Drain starts at offset 0; backlog (max id 5) is acked at offset 6, where an
    // empty immediate poll ends the drain.
    const offsets = api.calls.filter((c) => c.method === "getUpdates").map((c) => c.body.offset)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(6)
    // The captured message (id 10) is acked server-side with a final offset 11.
    expect(offsets[offsets.length - 1]).toBe(11)
  } finally {
    api.stop()
  }
})

test("captureFirstSender drains the backlog BEFORE getMe so a slow identity fetch can't drop the first message", async () => {
  // The regression this guards: getMe used to run first (in startPairing), so a
  // message the user sent during a slow getMe sat in the queue and was then swept
  // up by capture's drain — pairing waited forever. The drain must pin the offset
  // baseline first; getMe (identity only) comes after. Batch 0 is the empty drain;
  // the message (id 10) is delivered by the post-getMe poll and must be captured.
  const api = fakeBotApi([[], [update(10, 42, "pair me")]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const captured = await captureFirstSender(poller, new AbortController().signal)
    expect(captured).toEqual({ userId: "42", userName: "u42", botUsername: "bot" })
    const firstGetUpdates = api.calls.findIndex((c) => c.method === "getUpdates")
    const getMeAt = api.calls.findIndex((c) => c.method === "getMe")
    expect(firstGetUpdates).toBeGreaterThanOrEqual(0)
    expect(getMeAt).toBeGreaterThan(firstGetUpdates)
  } finally {
    api.stop()
  }
})

test("captureFirstSender drains a MULTI-batch backlog before accepting a sender", async () => {
  // The pre-pairing backlog spans two batches (stale users 7 then 8). A single
  // immediate drain would stop after batch 0, and the long-poll would then hand
  // back user 8's stale message as the "new" sender. The drain must consume both
  // stale batches (until an empty poll) before the real pairing message (user 42).
  const api = fakeBotApi([[update(5, 7, "stale")], [update(6, 8, "also stale")], [], [update(10, 42, "pair me")]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const captured = await captureFirstSender(poller, new AbortController().signal)
    expect(captured).toEqual({ userId: "42", userName: "u42", botUsername: "bot" })
  } finally {
    api.stop()
  }
})

test("captureFirstSender ignores group and non-text updates, keeps waiting", async () => {
  const api = fakeBotApi([[], [groupUpdate(10, 7)], [update(11, 42, "pair me")]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const captured = await captureFirstSender(poller, new AbortController().signal)
    expect(captured).toEqual({ userId: "42", userName: "u42", botUsername: "bot" })
  } finally {
    api.stop()
  }
})

test("captureFirstSender returns null when the signal aborts first", async () => {
  const api = fakeBotApi([]) // only ever returns empty batches
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 30)
    expect(await captureFirstSender(poller, ac.signal)).toBeNull()
  } finally {
    api.stop()
  }
})

test("captureFirstSender retries a transient final ack so the pairing message is not replayed", async () => {
  // A hand-rolled server so we can fail one specific call: the final ack of the
  // captured message. offset 0 is hit twice (empty drain, then the wait loop that
  // returns the pairing message); offset 11 acks update 10 — fail it once
  // (transient 500), then succeed. The retry is what actually acks the message;
  // if it were swallowed, the steady-state bridge (which polls from offset 0)
  // would hand the pairing text back as the user's first prompt.
  let zeroPolls = 0
  let ackAttempts = 0
  const offsets: number[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop() ?? ""
      const body: any = await req.json().catch(() => ({}))
      if (method === "getMe") return json({ ok: true, result: { id: 1, username: "bot" } })
      if (method !== "getUpdates") return json({ ok: true, result: {} })
      const offset = Number(body.offset ?? 0)
      offsets.push(offset)
      if (offset === 0) {
        zeroPolls++
        return json({ ok: true, result: zeroPolls === 1 ? [] : [update(10, 42, "pair me")] })
      }
      if (offset === 11) {
        ackAttempts++
        if (ackAttempts === 1) return json({ ok: false, error_code: 500, description: "transient" })
        return json({ ok: true, result: [] })
      }
      return json({ ok: true, result: [] })
    },
  })
  try {
    const poller = new TelegramPoller("t", `http://localhost:${server.port}`)
    poller.pollRetryMs = 0
    const captured = await captureFirstSender(poller, new AbortController().signal)
    expect(captured).toEqual({ userId: "42", userName: "u42", botUsername: "bot" })
    // The ack was retried after the transient failure (not swallowed): two calls
    // at offset 11, so update 10 is acked and cannot be replayed to the bridge.
    expect(ackAttempts).toBe(2)
    expect(offsets.filter((o) => o === 11)).toEqual([11, 11])
  } finally {
    server.stop(true)
  }
})

test("captureFirstSender signals onValidated only after the token is proven", async () => {
  const api = fakeBotApi([[], [update(10, 42, "pair me")]])
  try {
    const poller = new TelegramPoller("t", api.url)
    poller.pollRetryMs = 0
    let getUpdatesWhenValidated = -1
    const captured = await captureFirstSender(poller, new AbortController().signal, () => {
      getUpdatesWhenValidated = api.calls.filter((c) => c.method === "getUpdates").length
    })
    expect(captured).toEqual({ userId: "42", userName: "u42", botUsername: "bot" })
    // Fired after the proving drain ran at least once — never before any network call.
    expect(getUpdatesWhenValidated).toBeGreaterThanOrEqual(1)
  } finally {
    api.stop()
  }
})

test("captureFirstSender never signals onValidated for a bad token", async () => {
  // A bad token fails the first getUpdates (the drain) with a fatal 401, so the
  // bind hint must never fire — the UI can't walk the user to "message the bot".
  const server = Bun.serve({ port: 0, fetch: () => json({ ok: false, error_code: 401, description: "Unauthorized" }) })
  try {
    const poller = new TelegramPoller("t", `http://localhost:${server.port}`)
    poller.pollRetryMs = 0
    let validated = false
    await expect(
      captureFirstSender(poller, new AbortController().signal, () => {
        validated = true
      }),
    ).rejects.toThrow(/401/)
    expect(validated).toBe(false)
  } finally {
    server.stop(true)
  }
})

test("start() rejects on an invalid token so the gateway can surface it", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => json({ ok: false, error_code: 401, description: "Unauthorized" }),
  })
  try {
    const platform = new TelegramPlatform({ token: "bad", allowFrom: "42", baseUrl: `http://localhost:${server.port}` })
    await expect(platform.start(() => {})).rejects.toThrow(/401/)
  } finally {
    server.stop(true)
  }
})
