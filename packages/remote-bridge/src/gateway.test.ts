import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deliveryConfig, Engine } from "./engine.ts"
import {
  App,
  createApp,
  decodeConfig,
  hasRemoteAudience,
  hydrateSessionLimit,
  loadConfig,
  type Config,
} from "./gateway.ts"
import { PawWorkClient } from "./pawwork-client.ts"
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
  readonly started = deferred<void>()
  private readonly stopped = deferred<void>()

  constructor(
    readonly name: string,
    private readonly opts: { sendErr?: Error; streamConnected?: () => boolean; startResolvesImmediately?: boolean } = {},
  ) {}

  async start(_handler: MessageHandler): Promise<void> {
    this.startedAfterStream = this.opts.streamConnected ? this.opts.streamConnected() : false
    this.started.resolve()
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
    const app = new App({
      client: undefined as unknown as PawWorkClient,
      engine: new Engine(new FailingSidecar()),
      platforms: [],
    })
    const platform = new FakePlatform("runtime-test-message-log")
    const msg: Message = { sessionKey: "runtime-test-message-log:dm:alice", content: "start" }
    app.messageHandler()(platform, msg)
    await waitUntil(() => warnings.length > 0)
    expect(warnings.some((args) => String(args[0]).includes("remote bridge failed to handle inbound message"))).toBe(true)
  } finally {
    console.warn = originalWarn
  }
})
