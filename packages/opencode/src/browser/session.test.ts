import { afterEach, describe, expect, test } from "bun:test"
import { WebSocketServer, type WebSocket } from "ws"
import { BrowserBridge } from "./browser-bridge"
import {
  BrowserToolTimeoutError,
  parseNavigableUrl,
  releaseBrowserSession,
  resetBrowserSessionsForTest,
  withBrowserPage,
} from "./session"

/**
 * Minimal CDP-speaking ws server standing in for the PR1 main-process bridge.
 * Responds to every command with `{}` unless a handler is scripted; records
 * the method sequence so tests can assert takeover/stealth behavior.
 */
class FakeCdpServer {
  readonly wss: WebSocketServer
  readonly methods: string[] = []
  readonly handlers = new Map<string, (params: unknown) => unknown>()
  private sockets = new Set<WebSocket>()
  private hung: Array<{ ws: WebSocket; id: number }> = []
  port = 0

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    this.port = (this.wss.address() as { port: number }).port
    this.wss.on("connection", (ws: WebSocket) => {
      this.sockets.add(ws)
      ws.on("close", () => this.sockets.delete(ws))
      ws.on("message", (data: unknown) => {
        const cmd = JSON.parse(String(data)) as { id: number; method: string; params?: unknown }
        this.methods.push(cmd.method)
        const handler = this.handlers.get(cmd.method)
        if (handler === HANG) {
          this.hung.push({ ws, id: cmd.id })
          return
        }
        const result = handler ? handler(cmd.params) : {}
        ws.send(JSON.stringify({ id: cmd.id, result }))
        // A reload commits a new document: emit the load event the client waits for.
        if (cmd.method === "Page.reload") {
          ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }))
        }
      })
    })
  }

  get endpoint() {
    return `ws://127.0.0.1:${this.port}/secret`
  }

  /** Mirror the PR1 bridge teardown: fail in-flight commands with an error frame, then close. */
  failInflightAndClose() {
    for (const { ws, id } of this.hung) {
      ws.send(JSON.stringify({ id, error: { code: -32000, message: "bridge closed" } }))
    }
    this.hung = []
    for (const ws of this.sockets) ws.close()
  }

  async close() {
    for (const ws of this.sockets) ws.terminate()
    // bun's ws shim does not reliably fire the close callback; don't let
    // fixture cleanup hang the suite over it.
    await Promise.race([
      new Promise<void>((resolve) => this.wss.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ])
  }
}

// Sentinel handler: swallow the command and never respond.
const HANG = (() => {}) as unknown as (params: unknown) => unknown

// CDPPage.getCurrentUrl() goes through Runtime.evaluate; script its return.
function scriptCurrentUrl(server: FakeCdpServer, url: string | null) {
  server.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: url } }))
}

let servers: FakeCdpServer[] = []
function makeServer(): FakeCdpServer {
  const server = new FakeCdpServer()
  servers.push(server)
  return server
}

function provideFakeHost(server: FakeCdpServer) {
  const released: string[] = []
  BrowserBridge.provideHost({
    resolveEndpoint: async () => ({ cdpEndpoint: server.endpoint }),
    releaseSession: async ({ sessionID }) => {
      released.push(sessionID)
    },
  })
  return released
}

afterEach(async () => {
  resetBrowserSessionsForTest()
  BrowserBridge.provideHost(null)
  for (const server of servers) await server.close()
  servers = []
})

describe("parseNavigableUrl", () => {
  test("accepts http and https, rejects everything else", () => {
    expect(parseNavigableUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
    expect(parseNavigableUrl("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/")
    expect(parseNavigableUrl("file:///etc/passwd")).toBeNull()
    expect(parseNavigableUrl("javascript:alert(1)")).toBeNull()
    expect(parseNavigableUrl("example.com")).toBeNull()
    expect(parseNavigableUrl("not a url")).toBeNull()
  })
})

describe("withBrowserPage", () => {
  test("fails with a typed bridge-unavailable error outside the desktop app", async () => {
    await expect(withBrowserPage("ses_x", "click", async () => "unreachable")).rejects.toMatchObject({
      code: "bridge-unavailable",
    })
  })

  test("connects lazily, reuses the connection, and skips reload on a blank page", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    provideFakeHost(server)

    const first = await withBrowserPage("ses_a", "snapshot", async (_page, info) => info.takeoverReloaded)
    const second = await withBrowserPage("ses_a", "snapshot", async () => "again")

    expect(first).toBe(false)
    expect(second).toBe("again")
    expect(server.methods.filter((m) => m === "Page.addScriptToEvaluateOnNewDocument").length).toBe(1)
    expect(server.methods).not.toContain("Page.reload")
  })

  test("takes over an already-open page by reloading it once for stealth", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "https://example.com/already-open")
    provideFakeHost(server)

    const first = await withBrowserPage("ses_a", "snapshot", async (_page, info) => info.takeoverReloaded)
    const second = await withBrowserPage("ses_a", "snapshot", async (_page, info) => info.takeoverReloaded)

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(server.methods.filter((m) => m === "Page.reload").length).toBe(1)
    // Stealth registration happened before the reload, so the reloaded
    // document is created with the script in place.
    expect(server.methods.indexOf("Page.addScriptToEvaluateOnNewDocument")).toBeLessThan(
      server.methods.indexOf("Page.reload"),
    )
  })

  test("rejects a stuck action with the tool-level timeout", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    provideFakeHost(server)

    // Connect first (connect itself needs Runtime.evaluate), then hang it.
    await withBrowserPage("ses_a", "snapshot", async () => {})
    server.handlers.set("Runtime.evaluate", HANG)

    await expect(
      withBrowserPage("ses_a", "wait", (page) => page.evaluate("hang"), { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(BrowserToolTimeoutError)
  }, 10_000)

  test("invalidates the cached connection when the bridge drops, then reconnects", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    provideFakeHost(server)

    await withBrowserPage("ses_a", "snapshot", async () => {})

    // Simulate the main bridge tearing down: server closes the socket; the
    // in-flight evaluate must reject fast (not wait out a 30s CDP timeout).
    server.handlers.set("Runtime.evaluate", HANG)
    const inflight = withBrowserPage("ses_a", "extract", (page) => page.evaluate("location.href"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    server.failInflightAndClose()
    await expect(inflight).rejects.toThrow(/CDP connection closed|bridge closed|CDP connection is not open/)

    // Next call re-resolves and reconnects instead of failing forever.
    const reconnected = makeServer()
    scriptCurrentUrl(reconnected, "about:blank")
    provideFakeHost(reconnected)
    const result = await withBrowserPage("ses_a", "snapshot", async () => "ok")
    expect(result).toBe("ok")
  }, 10_000)

  test("release closes the connection and notifies the host once the last session lets go", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    const released = provideFakeHost(server)

    await withBrowserPage("ses_a", "snapshot", async () => {})
    await releaseBrowserSession("ses_a")
    expect(released).toEqual(["ses_a"])

    // Released session reconnects cleanly afterwards.
    const again = await withBrowserPage("ses_a", "snapshot", async () => "fresh")
    expect(again).toBe("fresh")
  })

  test("release for an unknown session is a no-op", async () => {
    const server = makeServer()
    const released = provideFakeHost(server)
    await releaseBrowserSession("ses_never_used")
    expect(released).toEqual([])
  })
})
