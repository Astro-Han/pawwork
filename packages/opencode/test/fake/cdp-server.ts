import { WebSocketServer, type WebSocket } from "ws"
import { BrowserBridge } from "../../src/browser/browser-bridge"

/**
 * Minimal CDP-speaking ws server standing in for the PR1 main-process bridge.
 * Responds to every command with `{}` unless a handler is scripted; records
 * the method sequence so tests can assert takeover/stealth behavior.
 */
export class FakeCdpServer {
  readonly wss: WebSocketServer
  readonly methods: string[] = []
  readonly handlers = new Map<string, (params: unknown) => unknown>()
  private sockets = new Set<WebSocket>()
  private hung: Array<{ ws: WebSocket; id: number }> = []
  port = 0
  /**
   * What the real window's webContents URL would be: tests preset it for
   * takeover scenarios, and Page.navigate keeps it current. Served by the
   * fake host's side-effect-free currentUrl probe.
   */
  url: string | null = null

  constructor() {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    this.port = (this.wss.address() as { port: number }).port
    this.wss.on("connection", (ws: WebSocket) => {
      this.sockets.add(ws)
      ws.on("close", () => this.sockets.delete(ws))
      ws.on("message", (data: unknown) => {
        const cmd = JSON.parse(String(data)) as { id: number; method: string; params?: unknown }
        this.methods.push(cmd.method)
        if (cmd.method === "Page.navigate") {
          this.url = (cmd.params as { url?: string } | undefined)?.url ?? null
        }
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
        // goto waits for the load event the same way.
        if (cmd.method === "Page.navigate") {
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

/** Sentinel handler: swallow the command and never respond. */
export const HANG = (() => {}) as unknown as (params: unknown) => unknown

/** CDPPage's evaluate-based reads (getCurrentUrl etc.) go through Runtime.evaluate; script its return. */
export function scriptCurrentUrl(server: FakeCdpServer, url: string | null) {
  server.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: url } }))
}

/** Inject a BrowserBridge host that always resolves to this fake server; returns the released-session log. */
export function provideFakeHost(server: FakeCdpServer): string[] {
  const released: string[] = []
  BrowserBridge.provideHost({
    resolveEndpoint: async () => ({ cdpEndpoint: server.endpoint }),
    probeWindow: async () => ({ windowID: 1, url: server.url }),
    releaseSession: async ({ sessionID }) => {
      released.push(sessionID)
    },
  })
  return released
}
