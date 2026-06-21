import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deliveryConfig, Engine } from "./engine.ts"
import {
  App,
  BridgeClosedError,
  createApp,
  decodeConfig,
  hasRemoteAudience,
  hydrateSessionLimit,
  loadConfig,
  type Config,
  type PlatformStatus,
} from "./gateway.ts"
import { PawWorkClient } from "./pawwork-client.ts"
import { SessionPointers } from "./session-pointers.ts"
import type { Message, MessageHandler, Platform, Sidecar } from "./types.ts"

// Zero the delivery backoff so the hydrate retry path runs instantly.
let savedBackoff = 0
beforeAll(() => {
  savedBackoff = deliveryConfig.backoffMs
  deliveryConfig.backoffMs = 0
})
afterAll(() => {
  deliveryConfig.backoffMs = savedBackoff
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

class FakePlatform implements Platform {
  sends: string[] = []
  reconstructKey = ""
  startedAfterStream = false
  readyCalls = 0
  stops = 0
  fireReady: () => void = () => {}
  readonly started = deferred<void>()
  private readonly stopped = deferred<void>()

  constructor(
    readonly name: string,
    private readonly opts: {
      sendErr?: Error
      startErr?: Error
      streamConnected?: () => boolean
      startResolvesImmediately?: boolean
      readyMode?: "auto" | "double" | "manual"
    } = {},
  ) {}

  async start(_handler: MessageHandler, onReady?: () => void): Promise<void> {
    this.startedAfterStream = this.opts.streamConnected ? this.opts.streamConnected() : false
    this.started.resolve()
    // A platform that connects but then fails (e.g. a revoked token rejected by the
    // upstream after the handshake) rejects start() before reaching "serving". The
    // supervisor degrades and retries it; it never reaches onReady.
    if (this.opts.startErr) throw this.opts.startErr
    // A real platform signals readiness once it is past startup and serving; model
    // that here so the gateway's run-level onReady fires in tests. "double" models a
    // misbehaving adapter; "manual" lets a test drive the moment via fireReady.
    const fire = () => {
      this.readyCalls++
      onReady?.()
    }
    const mode = this.opts.readyMode ?? "auto"
    if (mode === "manual") this.fireReady = fire
    else {
      fire()
      if (mode === "double") fire()
    }
    // An event-driven adapter may register its callback and return right away;
    // model that with startResolvesImmediately instead of blocking until stop().
    if (this.opts.startResolvesImmediately) return
    await this.stopped.promise
  }
  async reply(): Promise<void> {}
  async send(_replyCtx: unknown, content: string): Promise<void> {
    this.sends.push(content)
    if (this.opts.sendErr) throw this.opts.sendErr
  }
  reconstructReplyCtx(remoteKey: string): unknown {
    this.reconstructKey = remoteKey
    return "restored-reply-context"
  }
  async stop(): Promise<void> {
    this.stops++
    this.stopped.resolve()
  }
}

class FailingSidecar implements Sidecar {
  async createSession(): Promise<string> {
    throw new Error("sidecar unavailable")
  }
  async sendPrompt(): Promise<void> {
    throw new Error("sidecar unavailable")
  }
  async listSessions(): Promise<never> {
    throw new Error("sidecar unavailable")
  }
  async abortSession(): Promise<boolean> {
    throw new Error("sidecar unavailable")
  }
  async replyPermission(): Promise<void> {
    throw new Error("sidecar unavailable")
  }
  async submitQuestion(): Promise<void> {
    throw new Error("sidecar unavailable")
  }
}

type Route = (req: Request, url: URL) => Response | undefined | Promise<Response | undefined>

function mockServer(route: Route) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      return (
        Promise.resolve(route(req, url)).then(
          (res) => res ?? new Response("not found", { status: 404 }),
        )
      )
    },
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

const jsonBody = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

/** A text/event-stream Response that stays open until the client disconnects.
 * Emits a leading SSE comment so the runtime flushes headers immediately (Bun
 * buffers a body-less stream), mirroring the Go test's explicit flush. */
function openEventStream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(":ok\n\n"))
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function tempStatePath(seed?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rb-gateway-"))
  const path = join(dir, "sessions.json")
  if (seed !== undefined) await writeFile(path, seed)
  return path
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now()
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((r) => setTimeout(r, 1))
  }
}

test("loadConfig reads base URL and platform options", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "rb-config-")), "config.json")
  await writeFile(
    path,
    JSON.stringify({
      pawWorkBaseURL: "http://127.0.0.1:4090",
      statePath: "/tmp/pawwork-remote-sessions.json",
      platforms: [{ name: "runtime-test", enabled: true, options: { token: "secret" } }],
    }),
  )
  const config = await loadConfig(path)
  expect(config.pawWorkBaseURL).toBe("http://127.0.0.1:4090")
  expect(config.platforms).toHaveLength(1)
  expect(config.platforms[0].options?.token).toBe("secret")
})

test("decodeConfig parses a config string", () => {
  const config = decodeConfig('{"pawWorkBaseURL":"x","statePath":"y","platforms":[]}')
  expect(config.pawWorkBaseURL).toBe("x")
})

test("createApp builds only enabled platforms", async () => {
  let created = 0
  const config: Config = {
    pawWorkBaseURL: "http://127.0.0.1:4090",
    statePath: await tempStatePath(),
    platforms: [
      { name: "runtime-test-enabled", enabled: true, options: { token: "enabled", allow_from: "U123" } },
      { name: "runtime-test-disabled", enabled: false },
    ],
  }
  const app = await createApp(config, (name, options) => {
    created++
    expect(options.token).toBe("enabled")
    return new FakePlatform(name)
  })
  expect(created).toBe(1)
  expect(app.platformNames()).toEqual(["runtime-test-enabled"])
})

test("createApp rejects a wildcard remote audience without building the platform", async () => {
  let created = 0
  const config: Config = {
    pawWorkBaseURL: "http://127.0.0.1:4090",
    statePath: await tempStatePath(),
    platforms: [{ name: "runtime-test-wildcard", enabled: true, options: { allow_from: "*" } }],
  }
  await expect(
    createApp(config, (name) => {
      created++
      return new FakePlatform(name)
    }),
  ).rejects.toThrow("specific allow_from")
  expect(created).toBe(0)
})

test("hasRemoteAudience gates wildcard and bare audiences", () => {
  const cases: { platform: string; options: Record<string, unknown>; want: boolean }[] = [
    { platform: "slack", options: { allow_from: "C123" }, want: true },
    { platform: "slack", options: { allow_from: "*" }, want: false },
    { platform: "slack", options: { allow_from: "" }, want: false },
    { platform: "slack", options: { allow_from: "  " }, want: false },
    { platform: "slack", options: {}, want: false },
    { platform: "feishu", options: { allow_chat: "oc_1", group_only: true }, want: true },
    { platform: "lark", options: { allow_chat: "oc_1", group_only: true }, want: true },
    { platform: "feishu", options: { allow_chat: "oc_1" }, want: false },
    { platform: "feishu", options: { allow_chat: "*", group_only: true }, want: false },
    { platform: "slack", options: { allow_chat: "oc_1", group_only: true }, want: false },
  ]
  for (const tc of cases) {
    expect(hasRemoteAudience(tc.platform, tc.options)).toBe(tc.want)
  }
})

test("hydrate resurfaces a pending interaction through the restored target", async () => {
  const platform = new FakePlatform("runtime-test-hydrate")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
        return jsonBody([
          { id: "ses_root", title: "Root" },
          { id: "ses_child", title: "Child", parentID: "ses_root" },
        ])
      case "/permission":
        return jsonBody([{ id: "perm_1", sessionID: "ses_child", permission: "edit", patterns: ["/repo/app.ts"] }])
      case "/external-result":
        return jsonBody([
          {
            part: {
              type: "tool",
              sessionID: "ses_child",
              messageID: "msg_1",
              callID: "call_1",
              tool: "question",
              state: { status: "running", metadata: { externalResultReady: true }, input: { questions: [{ question: "Pick one" }] } },
            },
          },
        ])
    }
    return undefined
  })
  try {
    const statePath = await tempStatePath(JSON.stringify({ sessions: { "runtime-test-hydrate:room:alice": "ses_root" } }))
    const app = await createApp(
      { pawWorkBaseURL: server.url, statePath, platforms: [{ name: "runtime-test-hydrate", enabled: true, options: { allow_from: "U123" } }] },
      () => platform,
    )
    await app.hydrate()
    expect(platform.reconstructKey).toBe("runtime-test-hydrate:room:alice")
    // Both pending items share root ses_root; single-active surfacing shows only
    // the permission, leaving the question queued until it is answered.
    expect(platform.sends).toHaveLength(1)
    expect(platform.sends[0]).toContain("PawWork needs your permission:")
  } finally {
    server.stop()
  }
})

test("hydrate requests a bounded session list", async () => {
  let sessionLimit = ""
  const platform = new FakePlatform("runtime-test-hydrate-bounded")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
        sessionLimit = url.searchParams.get("limit") ?? ""
        return jsonBody([])
      case "/permission":
      case "/external-result":
        return jsonBody([])
    }
    return undefined
  })
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-hydrate-bounded", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    await app.hydrate()
    expect(sessionLimit).toBe(String(hydrateSessionLimit))
  } finally {
    server.stop()
  }
})

test("hydrate keeps going when a pending delivery fails, after bounded retries", async () => {
  const platform = new FakePlatform("runtime-test-hydrate-send-failure", { sendErr: new Error("chat unavailable") })
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
        return jsonBody([
          { id: "ses_root", title: "Root" },
          { id: "ses_child", title: "Child", parentID: "ses_root" },
        ])
      case "/permission":
        return jsonBody([{ id: "perm_1", sessionID: "ses_child", permission: "edit", patterns: ["/repo/app.ts"] }])
      case "/external-result":
        return jsonBody([])
    }
    return undefined
  })
  try {
    const statePath = await tempStatePath(
      JSON.stringify({ sessions: { "runtime-test-hydrate-send-failure:room:alice": "ses_root" } }),
    )
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath,
        platforms: [{ name: "runtime-test-hydrate-send-failure", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    // Should not throw — a pending delivery that keeps failing is logged and skipped.
    await app.hydrate()
    expect(platform.sends).toHaveLength(deliveryConfig.attempts)
  } finally {
    server.stop()
  }
})

test("run connects the event stream before starting platforms", async () => {
  let streamConnected = false
  const platform = new FakePlatform("runtime-test-stream-before-platform", { streamConnected: () => streamConnected })
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        streamConnected = true
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  let app: App
  try {
    app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-stream-before-platform", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    const runPromise = app.run(controller.signal)
    await platform.started.promise
    expect(platform.startedAfterStream).toBe(true)
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("run stays up when a platform start resolves on its own", async () => {
  // A self-resolving start() (an adapter that registers a callback and returns)
  // is not a failure: the bridge must stay up until abort, like Go's App.Run
  // where a goroutine returning nil sends nothing to errCh.
  const platform = new FakePlatform("runtime-test-self-resolving-start", { startResolvesImmediately: true })
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-self-resolving-start", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    const runPromise = app.run(controller.signal)
    await platform.started.promise
    // run() must remain pending even though start() already resolved.
    const pending = Symbol("pending")
    const raced = await Promise.race([
      runPromise.then(() => "resolved" as const),
      new Promise<typeof pending>((r) => setTimeout(() => r(pending), 50)),
    ])
    expect(raced).toBe(pending)
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("run fires onReady only after the stream, hydrate, and platform are serving", async () => {
  // The startup-race guard: a caller's "connected" must trail real readiness, so
  // run's onReady cannot precede the stream, the hydrate, or the platform start.
  const order: string[] = []
  const platform = new FakePlatform("runtime-test-onready-after-serving")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
        order.push("hydrate")
        return jsonBody([])
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        order.push("stream")
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-onready-after-serving", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    const ready = deferred<void>()
    const runPromise = app.run(controller.signal, () => {
      order.push("ready")
      ready.resolve()
    })
    await ready.promise
    expect(order.indexOf("ready")).toBeGreaterThan(order.indexOf("stream"))
    expect(order.indexOf("ready")).toBeGreaterThan(order.indexOf("hydrate"))
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("run's onReady counts each platform once, even when an adapter double-fires", async () => {
  // Supervisor hardening: the contract says a platform signals readiness a single
  // time, but one adapter firing onReady twice must not satisfy the whole set — the
  // bridge stays "connecting" until every platform is actually serving.
  let readyFired = 0
  const doubleFirer = new FakePlatform("runtime-test-double-ready", { readyMode: "double" })
  const lateComer = new FakePlatform("runtime-test-late-ready", { readyMode: "manual" })
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [
          { name: "runtime-test-double-ready", enabled: true, options: { allow_from: "U123" } },
          { name: "runtime-test-late-ready", enabled: true, options: { allow_from: "U456" } },
        ],
      },
      (name) => (name === "runtime-test-double-ready" ? doubleFirer : lateComer),
    )
    const runPromise = app.run(controller.signal, () => {
      readyFired++
    })
    // Both platforms have started: the first fired onReady twice, the second has not
    // fired yet. The two duplicate fires must not stand in for the missing platform.
    await doubleFirer.started.promise
    await lateComer.started.promise
    await waitUntil(() => doubleFirer.readyCalls === 2)
    expect(readyFired).toBe(0)
    // The second platform serving completes the set — run's onReady fires exactly once.
    lateComer.fireReady()
    await waitUntil(() => readyFired === 1)
    expect(readyFired).toBe(1)
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("run connects the event stream before the initial hydrate", async () => {
  const order: string[] = []
  const platform = new FakePlatform("runtime-test-stream-before-hydrate")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
        order.push("hydrate")
        return jsonBody([])
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        order.push("stream")
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-stream-before-hydrate", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    const runPromise = app.run(controller.signal)
    await platform.started.promise
    expect(order[0]).toBe("stream")
    expect(order[1]).toBe("hydrate")
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("run retries transient event-stream errors", async () => {
  let eventRequests = 0
  const platform = new FakePlatform("runtime-test-event-retry")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        eventRequests++
        if (eventRequests === 1) return new Response("temporary", { status: 500 })
        return new Response('data: {"payload":{"type":"server.connected","properties":{}}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-event-retry", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    app.eventRetryDelayMs = 1
    const runPromise = app.run(controller.signal)
    await waitUntil(() => eventRequests >= 2)
    controller.abort()
    await runPromise
    expect(eventRequests).toBeGreaterThanOrEqual(2)
  } finally {
    server.stop()
  }
})

test("run re-hydrates after a replay-gap signal on reconnect", async () => {
  let eventRequests = 0
  let permissionRequests = 0
  let reconnectCarriedCursor = true
  const platform = new FakePlatform("runtime-test-event-gap")
  const server = mockServer((req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/external-result":
        return jsonBody([])
      case "/permission":
        permissionRequests++
        return jsonBody([])
      case "/global/event": {
        eventRequests++
        if (eventRequests === 1) {
          return new Response('id: cursor-1\ndata: {"payload":{"type":"server.connected","properties":{}}}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        }
        if (!req.headers.get("Last-Event-ID")) reconnectCarriedCursor = false
        return new Response('id: cursor-2\ndata: {"payload":{"type":"server.connected","properties":{}}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      }
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "runtime-test-event-gap", enabled: true, options: { allow_from: "U123" } }],
      },
      () => platform,
    )
    app.eventRetryDelayMs = 1
    const runPromise = app.run(controller.signal)
    await waitUntil(() => permissionRequests >= 2)
    controller.abort()
    await runPromise
    expect(permissionRequests).toBeGreaterThanOrEqual(2)
    expect(reconnectCarriedCursor).toBe(true)
  } finally {
    server.stop()
  }
})

test("messageHandler logs engine failures", async () => {
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }
  try {
    const platform = new FakePlatform("runtime-test-message-log")
    const app = new App({
      client: undefined as unknown as PawWorkClient,
      engine: new Engine(new FailingSidecar()),
      pointers: SessionPointers.memory(),
      factory: () => platform,
    })
    // Register the platform as the live instance, so the handler's liveness guard
    // lets the message through to the (failing) engine.
    await app.addPlatform({ name: platform.name, enabled: true, options: { allow_from: "U123" } })
    const msg: Message = { sessionKey: "runtime-test-message-log:dm:alice", content: "start" }
    app.messageHandler()(platform, msg)
    await waitUntil(() => warnings.length > 0)
    expect(warnings.some((args) => String(args[0]).includes("remote bridge failed to handle inbound message"))).toBe(true)
  } finally {
    console.warn = originalWarn
  }
})

test("messageHandler drops an inbound from a platform that is no longer the live instance", async () => {
  // A removed or replaced channel's in-flight message must not create a session or
  // send a prompt: the gateway owns the live set, so a stale instance is ignored.
  const platform = new FakePlatform("runtime-test-stale-inbound")
  const app = new App({
    client: undefined as unknown as PawWorkClient,
    engine: new Engine(new FailingSidecar()),
    pointers: SessionPointers.memory(),
    factory: () => platform,
  })
  await app.addPlatform({ name: platform.name, enabled: true, options: { allow_from: "U123" } })
  await app.removePlatform(platform.name)

  let warned = false
  const originalWarn = console.warn
  console.warn = () => {
    warned = true
  }
  try {
    // The same instance delivers after removal: a live handler would hit the
    // FailingSidecar and warn; the guard drops it, so nothing is logged.
    app.messageHandler()(platform, { sessionKey: "runtime-test-stale-inbound:dm:alice", content: "late" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(warned).toBe(false)
  } finally {
    console.warn = originalWarn
  }
})

test("addPlatform connects a new channel without restarting the shared event stream", async () => {
  let streamConnects = 0
  const first = new FakePlatform("rt-add-first")
  const second = new FakePlatform("rt-add-second")
  const built: Record<string, FakePlatform> = { "rt-add-first": first, "rt-add-second": second }
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        streamConnects++
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const ready = deferred<void>()
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "rt-add-first", enabled: true, options: { allow_from: "U1" } }],
      },
      (name) => built[name],
    )
    const runPromise = app.run(controller.signal, () => ready.resolve())
    await ready.promise
    await first.started.promise
    expect(streamConnects).toBe(1)

    // Connect a second channel on the running app: it starts, the shared stream is
    // not restarted, and the first channel is never stopped.
    await app.addPlatform({ name: "rt-add-second", enabled: true, options: { allow_from: "U2" } })
    await second.started.promise
    expect(app.platformNames().sort()).toEqual(["rt-add-first", "rt-add-second"])
    expect(streamConnects).toBe(1)
    expect(first.stops).toBe(0)
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("removePlatform stops only that channel, leaving the stream and the others up", async () => {
  let streamConnects = 0
  const keep = new FakePlatform("rt-keep")
  const drop = new FakePlatform("rt-drop")
  const built: Record<string, FakePlatform> = { "rt-keep": keep, "rt-drop": drop }
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        streamConnects++
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [
          { name: "rt-keep", enabled: true, options: { allow_from: "U1" } },
          { name: "rt-drop", enabled: true, options: { allow_from: "U2" } },
        ],
      },
      (name) => built[name],
    )
    const runPromise = app.run(controller.signal)
    await keep.started.promise
    await drop.started.promise
    expect(streamConnects).toBe(1)

    await app.removePlatform("rt-drop")
    expect(app.platformNames()).toEqual(["rt-keep"])
    expect(drop.stops).toBe(1) // the removed channel's loop was stopped
    expect(keep.stops).toBe(0) // the survivor was untouched
    expect(streamConnects).toBe(1) // shared stream never restarted
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("a re-pair whose factory throws leaves the existing channel serving (prepare-first)", async () => {
  // Prepare-first: the replacement is built BEFORE the old loop is retired, so a
  // factory failure on a re-pair leaves the working channel up — not stopped, and
  // still the live instance. The caller rolls back its saved account instead of
  // losing the connection.
  const original = new FakePlatform("rt-repair")
  let builds = 0
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "rt-repair", enabled: true, options: { allow_from: "U1" } }],
      },
      (name) => {
        builds++
        if (builds === 1) return original
        throw new Error("rebuild boom") // the re-pair's build fails
      },
    )
    const runPromise = app.run(controller.signal)
    await original.started.promise

    // Re-pair the same name; the second build throws.
    await expect(
      app.addPlatform({ name: "rt-repair", enabled: true, options: { allow_from: "U2" } }),
    ).rejects.toThrow("rebuild boom")

    // The old instance was never touched: still serving, still the live instance.
    expect(original.stops).toBe(0)
    expect(app.platformNames()).toEqual(["rt-repair"])

    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("a re-pair with an invalid audience leaves the existing channel serving (prepare-first)", async () => {
  // The audience gate fails before any swap, so a same-name re-pair with a wildcard
  // audience leaves the working channel serving and untouched. (A *new* name that
  // fails the gate also leaves existing channels untouched — see the next test.)
  const original = new FakePlatform("rt-repair-audience")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "rt-repair-audience", enabled: true, options: { allow_from: "U1" } }],
      },
      () => original,
    )
    const runPromise = app.run(controller.signal)
    await original.started.promise

    // Re-pair the same name with a wildcard audience: the gate rejects it.
    await expect(
      app.addPlatform({ name: "rt-repair-audience", enabled: true, options: { allow_from: "*" } }),
    ).rejects.toThrow("specific allow_from")

    // Untouched: still serving, still the live instance.
    expect(original.stops).toBe(0)
    expect(app.platformNames()).toEqual(["rt-repair-audience"])

    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("a re-pair whose new platform fails to start retires the old and surfaces the new as degraded", async () => {
  // Build-success semantics, not connected-success: addPlatform retires the old loop and
  // supervises the new one once it is built (and any beforeCommit persists), NOT once it
  // is serving. So a re-pair whose new platform start() rejects replaces the old channel
  // and shows the new one degraded (the supervisor retries it) — it does not keep the old
  // channel serving. The pairing flow already proved the new token live, so the residual
  // failure window is a transient the supervisor retries, not a lost working connection.
  const original = new FakePlatform("rt-repair-start")
  const replacement = new FakePlatform("rt-repair-start", { startErr: new Error("token revoked") })
  let builds = 0
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const statuses: PlatformStatus[] = []
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "rt-repair-start", enabled: true, options: { allow_from: "U1" } }],
      },
      () => {
        builds++
        return builds === 1 ? original : replacement
      },
    )
    app.platformRetryDelayMs = 5 // keep the degraded retry loop tight for the test
    const runPromise = app.run(controller.signal, undefined, (status) => statuses.push(status))
    await original.started.promise

    // Re-pair the same name; the build succeeds, so the old loop is retired and the new
    // platform supervised — then its start() rejects.
    await app.addPlatform({ name: "rt-repair-start", enabled: true, options: { allow_from: "U2" } })
    await replacement.started.promise

    expect(original.stops).toBe(1) // old channel retired on the successful build
    expect(app.platformNames()).toEqual(["rt-repair-start"]) // the new platform is the live one
    // The new channel surfaces degraded (and keeps retrying); the old one is gone.
    await waitUntil(() => statuses.some((s) => s.name === "rt-repair-start" && s.phase === "degraded"))

    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})

test("addPlatform that finishes building after teardown throws BridgeClosedError, not a silent no-op", async () => {
  // The fatal-stream race: the shared stream can die while a re-pair is still building. Once
  // run() tears down (supervisor cleared), the live supervise would silently no-op and report
  // a success the channel never honored. addPlatform must instead throw, so the caller rebuilds
  // from the persisted accounts rather than trusting an add that never took effect.
  const original = new FakePlatform("rt-teardown")
  let releaseBuild!: () => void
  const buildGate = new Promise<void>((resolve) => (releaseBuild = resolve))
  let builds = 0
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "rt-teardown", enabled: true, options: { allow_from: "U1" } }],
      },
      () => {
        builds++
        // The re-pair's build blocks until the test releases it — letting us tear the bridge
        // down while addPlatform is mid-await, exactly the window the guard must catch.
        return builds === 1 ? original : buildGate.then(() => new FakePlatform("rt-teardown"))
      },
    )
    const runPromise = app.run(controller.signal)
    await original.started.promise

    // Start a re-pair; its factory is still awaiting the build gate.
    const repair = app.addPlatform({ name: "rt-teardown", enabled: true, options: { allow_from: "U2" } })
    // Tear the bridge down while the build is in flight, then let the build finish.
    controller.abort()
    await runPromise
    releaseBuild()

    await expect(repair).rejects.toBeInstanceOf(BridgeClosedError)
  } finally {
    server.stop()
  }
})

test("addPlatform refuses a wildcard audience on a running app", async () => {
  const platform = new FakePlatform("rt-wildcard-add")
  const server = mockServer((_req, url) => {
    switch (url.pathname) {
      case "/experimental/session":
      case "/permission":
      case "/external-result":
        return jsonBody([])
      case "/global/event":
        return openEventStream()
    }
    return undefined
  })
  const controller = new AbortController()
  try {
    const app = await createApp(
      {
        pawWorkBaseURL: server.url,
        statePath: await tempStatePath(),
        platforms: [{ name: "rt-wildcard-add", enabled: true, options: { allow_from: "U1" } }],
      },
      () => platform,
    )
    const runPromise = app.run(controller.signal)
    await platform.started.promise
    await expect(
      app.addPlatform({ name: "rt-evil", enabled: true, options: { allow_from: "*" } }),
    ).rejects.toThrow("specific allow_from")
    expect(app.platformNames()).toEqual(["rt-wildcard-add"])
    controller.abort()
    await runPromise
  } finally {
    server.stop()
  }
})
