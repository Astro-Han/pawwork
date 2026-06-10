import { afterEach, describe, expect, test } from "bun:test"
import { BrowserBridge } from "../../src/browser/browser-bridge"
import {
  BrowserToolTimeoutError,
  parseNavigableUrl,
  releaseBrowserSession,
  resetBrowserSessionsForTest,
  withBrowserPage,
} from "../../src/browser/session"
import { FakeCdpServer, HANG, provideFakeHost, scriptCurrentUrl } from "../fake/cdp-server"

let servers: FakeCdpServer[] = []
function makeServer(): FakeCdpServer {
  const server = new FakeCdpServer()
  servers.push(server)
  return server
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

  test("concurrent first calls share a single connection attempt", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    provideFakeHost(server)

    const results = await Promise.all([
      withBrowserPage("ses_a", "snapshot", async () => "first"),
      withBrowserPage("ses_a", "extract", async () => "second"),
    ])

    expect(results).toEqual(["first", "second"])
    // One stealth registration = one CDP connect; the single-client bridge
    // never saw a competing second connection.
    expect(server.methods.filter((m) => m === "Page.addScriptToEvaluateOnNewDocument").length).toBe(1)
  })

  test("two sessions racing onto the same endpoint share one connection", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    provideFakeHost(server)

    const results = await Promise.all([
      withBrowserPage("ses_a", "snapshot", async () => "a"),
      withBrowserPage("ses_b", "snapshot", async () => "b"),
    ])

    expect(results).toEqual(["a", "b"])
    expect(server.methods.filter((m) => m === "Page.addScriptToEvaluateOnNewDocument").length).toBe(1)
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

    // Simulate the main bridge tearing down: in-flight commands are failed
    // with an error frame, then the socket closes (PR1 stop() semantics).
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

  test("rolls back the host attachment when the connect after a successful resolve fails", async () => {
    const released: string[] = []
    BrowserBridge.provideHost({
      // The host attaches successfully, but the endpoint it hands back is
      // dead — connect fails after the attachment exists.
      resolveEndpoint: async () => ({ cdpEndpoint: "ws://127.0.0.1:9/nobody-listens" }),
      probeWindow: async () => ({ windowID: 1, url: null }),
      releaseSession: async ({ sessionID }) => {
        released.push(sessionID)
      },
    })

    await expect(withBrowserPage("ses_a", "snapshot", async () => "unreachable")).rejects.toThrow()
    expect(released).toEqual(["ses_a"])
  }, 10_000)

  test("a release landing during a pending acquire still cleans up after it settles", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    const released: string[] = []
    BrowserBridge.provideHost({
      resolveEndpoint: async () => {
        // Keep the acquire in flight long enough for the release to land first.
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { cdpEndpoint: server.endpoint }
      },
      probeWindow: async () => ({ windowID: 1, url: null }),
      releaseSession: async ({ sessionID }) => {
        released.push(sessionID)
      },
    })

    const inflight = withBrowserPage("ses_a", "snapshot", async () => "ok")
    await new Promise((resolve) => setTimeout(resolve, 10))
    await releaseBrowserSession("ses_a")

    // The release waited for the acquire to settle, then tore it down.
    expect(released).toEqual(["ses_a"])
    await expect(inflight).resolves.toBe("ok")

    // No stale mapping survived: the next call reconnects from scratch.
    await withBrowserPage("ses_a", "snapshot", async () => "again")
    expect(server.methods.filter((m) => m === "Page.addScriptToEvaluateOnNewDocument").length).toBe(2)
  }, 10_000)

  test("a lost connection still tells the host to release its sessions, exactly once", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    const released = provideFakeHost(server)

    await withBrowserPage("ses_a", "snapshot", async () => {})

    server.handlers.set("Runtime.evaluate", HANG)
    const inflight = withBrowserPage("ses_a", "extract", (page) => page.evaluate("location.href"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    server.failInflightAndClose()
    await expect(inflight).rejects.toThrow(/CDP connection closed|bridge closed|CDP connection is not open/)

    // invalidate() notified the host so the main process detaches its stale
    // bridge (fire-and-forget; give the microtask a beat).
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(released).toEqual(["ses_a"])

    // The session's later delete/archive finds no mapping and must not
    // release a second time.
    await releaseBrowserSession("ses_a")
    expect(released).toEqual(["ses_a"])
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
