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
