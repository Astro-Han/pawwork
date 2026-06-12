import { describe, expect, test } from "bun:test"
import { CDPBridge } from "@jackwener/opencli/browser/cdp"
import { htmlToMarkdown } from "@jackwener/opencli/utils"
import { WebSocketServer } from "ws"

/**
 * Contract test against the pinned @jackwener/opencli release: every IPage
 * member the 7 browser tools (and BrowserSession) call must exist on the page
 * object CDPBridge.connect() returns. A version bump that drops or renames
 * one of these fails here instead of at runtime in a user's session.
 */

// page methods the tools map to (design doc §6) + the ones BrowserSession itself uses.
const REQUIRED_PAGE_METHODS = [
  "goto",
  "snapshot",
  "click",
  "fillText",
  "pressKey",
  "wait",
  "screenshot",
  "evaluate",
  "getCurrentUrl",
] as const

// optional in the IPage type; tools degrade when absent, but the *property
// slot* is part of the contract we read. (evaluateWithArgs is deliberately not
// here: it injects each arg as a top-level const — the var is `selector`, not
// `args.selector` — so the tools serialize args into evaluate() instead.)
const OPTIONAL_PAGE_METHODS = ["annotatedScreenshot"] as const

async function connectToFake(): Promise<{ page: Record<string, unknown>; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  const port = (wss.address() as { port: number }).port
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const cmd = JSON.parse(String(data)) as { id: number }
      ws.send(JSON.stringify({ id: cmd.id, result: {} }))
    })
  })
  const bridge = new CDPBridge()
  let page: Record<string, unknown>
  try {
    page = (await bridge.connect({ cdpEndpoint: `ws://127.0.0.1:${port}/secret` })) as unknown as Record<
      string,
      unknown
    >
  } catch (err) {
    // The caller only gets `close` on success; release the listener here or a
    // failed connect leaks the server into the rest of the test process.
    wss.close()
    throw err
  }
  return {
    page,
    close: async () => {
      await bridge.close()
      await Promise.race([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ])
    },
  }
}

describe("opencli contract", () => {
  test("CDPBridge exposes the bridge-level API BrowserSession uses", () => {
    const bridge = new CDPBridge()
    expect(typeof bridge.connect).toBe("function")
    expect(typeof bridge.close).toBe("function")
    expect(typeof bridge.send).toBe("function")
    expect(typeof bridge.waitForEvent).toBe("function")
  })

  test("the connected page implements every method the browser tools call", async () => {
    const { page, close } = await connectToFake()
    try {
      for (const method of REQUIRED_PAGE_METHODS) {
        expect(typeof page[method]).toBe("function")
      }
      for (const method of OPTIONAL_PAGE_METHODS) {
        const kind = typeof page[method]
        expect(kind === "function" || kind === "undefined").toBe(true)
      }
    } finally {
      await close()
    }
  })

  test("htmlToMarkdown converts extracted page HTML", () => {
    const markdown = htmlToMarkdown("<h1>Title</h1><p>Body with <a href='https://example.com'>link</a>.</p>")
    expect(markdown).toContain("Title")
    expect(markdown).toContain("[link](https://example.com)")
  })
})
