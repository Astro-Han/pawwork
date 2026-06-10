import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { WebContents } from "electron"
import { type ClientOptions, WebSocket } from "ws"
import { CdpBridge, CdpBridgeError } from "./cdp-bridge"

// Stand-in for webContents.debugger: an EventEmitter that records sendCommand
// calls and lets a test drive its result and emit CDP messages/detach.
class MockDebugger extends EventEmitter {
  attached = false
  calls: Array<{ method: string; params: unknown; sessionId?: string }> = []
  impl: (method: string, params: unknown, sessionId?: string) => Promise<unknown> = async () => ({})
  isAttached() {
    return this.attached
  }
  attach(_version?: string) {
    this.attached = true
  }
  detach() {
    this.attached = false
  }
  sendCommand(method: string, params?: unknown, sessionId?: string) {
    this.calls.push({ method, params, sessionId })
    return this.impl(method, params, sessionId)
  }
}

class MockWebContents {
  destroyed = false
  debugger = new MockDebugger()
  isDestroyed() {
    return this.destroyed
  }
}

function makeWc() {
  const wc = new MockWebContents()
  return { wc, asWebContents: wc as unknown as WebContents }
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function startBridge(wc: WebContents) {
  const bridge = new CdpBridge(wc)
  const endpoint = await bridge.start()
  cleanups.push(() => bridge.stop())
  return { bridge, cdpEndpoint: endpoint.cdpEndpoint }
}

function open(url: string, opts?: ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts)
    let settled = false
    // Persistent error handler: a rejected upgrade (and teardown-time resets)
    // emit 'error' — keep listening so none of them surface as unhandled.
    ws.on("error", (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    ws.on("open", () => {
      if (settled) return
      settled = true
      cleanups.push(() => ws.terminate())
      resolve(ws)
    })
  })
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)))))
}

function withDifferentSecret(endpoint: string): string {
  return endpoint.replace(/\/[^/]+$/, "/0000000000000000")
}

describe("CdpBridge", () => {
  test("relays a CDP command to the debugger and returns its result", async () => {
    const { wc, asWebContents } = makeWc()
    wc.debugger.impl = async () => ({ result: { value: 42 } })
    const { cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(cdpEndpoint)
    ws.send(JSON.stringify({ id: 7, method: "Runtime.evaluate", params: { expression: "6*7" } }))
    const msg = await nextMessage(ws)
    expect(msg.id).toBe(7)
    expect(msg.result).toEqual({ result: { value: 42 } })
    expect(wc.debugger.calls[0]?.method).toBe("Runtime.evaluate")
  })

  test("forwards debugger events to the client", async () => {
    const { wc, asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(cdpEndpoint)
    const received = nextMessage(ws)
    wc.debugger.emit("message", {}, "Page.frameNavigated", { frame: { id: "x" } }, "")
    const msg = await received
    expect(msg.method).toBe("Page.frameNavigated")
    expect(msg.params).toEqual({ frame: { id: "x" } })
  })

  test("surfaces a debugger command error as a CDP error response", async () => {
    const { wc, asWebContents } = makeWc()
    wc.debugger.impl = async () => {
      throw new Error("boom")
    }
    const { cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(cdpEndpoint)
    ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: {} }))
    const msg = (await nextMessage(ws)) as { id: number; error: { message: string } }
    expect(msg.id).toBe(1)
    expect(msg.error.message).toBe("boom")
  })

  test("a query string after the secret path does not break authorization", async () => {
    const { asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(`${cdpEndpoint}?v=1`)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  test("rejects a wrong secret at the upgrade", async () => {
    const { asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    await expect(open(withDifferentSecret(cdpEndpoint))).rejects.toThrow()
  })

  test("a rejected wrong-secret attempt does not consume the single slot", async () => {
    const { asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    await expect(open(withDifferentSecret(cdpEndpoint))).rejects.toThrow()
    const ws = await open(cdpEndpoint)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  test("rejects a connection that carries a browser Origin", async () => {
    const { asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    await expect(open(cdpEndpoint, { headers: { origin: "https://evil.example" } })).rejects.toThrow()
  })

  test("rejects a mismatched Host header (DNS-rebinding guard)", async () => {
    const { asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    await expect(open(cdpEndpoint, { headers: { host: "evil.example" } })).rejects.toThrow()
  })

  test("allows only one connection at a time", async () => {
    const { asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    const first = await open(cdpEndpoint)
    expect(first.readyState).toBe(WebSocket.OPEN)
    await expect(open(cdpEndpoint)).rejects.toThrow()
  })

  test("redactedEndpoint never exposes the secret", async () => {
    const { asWebContents } = makeWc()
    const { bridge, cdpEndpoint } = await startBridge(asWebContents)
    const secret = cdpEndpoint.split("/").pop() ?? ""
    expect(secret.length).toBeGreaterThan(0)
    expect(bridge.redactedEndpoint).not.toContain(secret)
    expect(bridge.redactedEndpoint).toContain("<secret>")
  })

  test("stop() detaches the debugger and closes the connection", async () => {
    const { wc, asWebContents } = makeWc()
    const bridge = new CdpBridge(asWebContents)
    const { cdpEndpoint } = await bridge.start()
    cleanups.push(() => bridge.stop())
    const ws = await open(cdpEndpoint)
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()))
    await bridge.stop()
    await closed
    expect(wc.debugger.attached).toBe(false)
  })

  test("teardown fails in-flight commands instead of leaving them to time out", async () => {
    const { wc, asWebContents } = makeWc()
    let release: (value: unknown) => void = () => {}
    // A command the debugger never answers on its own.
    wc.debugger.impl = () => new Promise((resolve) => (release = resolve))
    const { bridge, cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(cdpEndpoint)
    const errored = nextMessage(ws)
    ws.send(JSON.stringify({ id: 99, method: "Page.navigate", params: {} }))
    await new Promise((resolve) => setTimeout(resolve, 20)) // let the command register as pending
    await bridge.stop()
    const msg = (await errored) as { id: number; error?: { message: string } }
    expect(msg.id).toBe(99)
    expect(msg.error?.message).toBe("bridge closed")
    release({}) // resolve the dangling promise so nothing leaks
  })

  test("teardown failure responses carry the command's sessionId", async () => {
    const { wc, asWebContents } = makeWc()
    let release: (value: unknown) => void = () => {}
    wc.debugger.impl = () => new Promise((resolve) => (release = resolve))
    const { bridge, cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(cdpEndpoint)
    const errored = nextMessage(ws)
    ws.send(JSON.stringify({ id: 5, method: "Page.navigate", params: {}, sessionId: "session-a" }))
    await new Promise((resolve) => setTimeout(resolve, 20)) // let the command register as pending
    await bridge.stop()
    const msg = (await errored) as { id: number; sessionId?: string; error?: { message: string } }
    expect(msg.id).toBe(5)
    expect(msg.sessionId).toBe("session-a")
    expect(msg.error?.message).toBe("bridge closed")
    release({})
  })

  test("a reconnecting client reusing a command id never sees the previous client's result", async () => {
    const { wc, asWebContents } = makeWc()
    const resolvers: Array<(value: unknown) => void> = []
    wc.debugger.impl = () => new Promise((resolve) => resolvers.push(resolve))
    const { cdpEndpoint } = await startBridge(asWebContents)

    const first = await open(cdpEndpoint)
    first.send(JSON.stringify({ id: 1, method: "Page.navigate", params: {} }))
    await new Promise((resolve) => setTimeout(resolve, 20)) // let id 1 register as pending
    first.terminate()

    // The single slot frees only once the server has processed the close.
    let second: WebSocket | null = null
    for (let attempt = 0; attempt < 50 && !second; attempt++) {
      second = await open(cdpEndpoint).catch(() => null)
      if (!second) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!second) throw new Error("could not reconnect after terminate")

    const answered = nextMessage(second)
    second.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {} }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    resolvers[0]?.({ stale: true }) // the dead connection's command completes late
    resolvers[1]?.({ fresh: true })
    const msg = (await answered) as { id: number; result: Record<string, unknown> }
    expect(msg.id).toBe(1)
    expect(msg.result).toEqual({ fresh: true })
  })

  test("an external debugger detach tears the bridge down", async () => {
    const { wc, asWebContents } = makeWc()
    const { cdpEndpoint } = await startBridge(asWebContents)
    const ws = await open(cdpEndpoint)
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()))
    // DevTools opening forcibly detaches the debugger.
    wc.debugger.emit("detach", {}, "Target.detachedFromTarget")
    await closed
    expect(ws.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING)
  })

  test("concurrent start() calls share one bridge instead of misreporting target-busy", async () => {
    const { asWebContents } = makeWc()
    const bridge = new CdpBridge(asWebContents)
    cleanups.push(() => bridge.stop())
    const [first, second] = await Promise.all([bridge.start(), bridge.start()])
    expect(first.cdpEndpoint).toBe(second.cdpEndpoint)
  })

  test("start() throws target-busy when the debugger is already attached", async () => {
    const { wc, asWebContents } = makeWc()
    wc.debugger.attached = true
    const bridge = new CdpBridge(asWebContents)
    await expect(bridge.start()).rejects.toBeInstanceOf(CdpBridgeError)
  })

  test("start() throws target-destroyed for a gone WebContents", async () => {
    const { wc, asWebContents } = makeWc()
    wc.destroyed = true
    const bridge = new CdpBridge(asWebContents)
    await expect(bridge.start()).rejects.toMatchObject({ code: "target-destroyed" })
  })
})
