import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, type Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { BrowserBridge } from "../../src/browser/browser-bridge"
import { resetBrowserSessionsForTest } from "../../src/browser/session"
import { BrowserNavigateTool } from "../../src/tool/browser-navigate"
import { BrowserSnapshotTool } from "../../src/tool/browser-snapshot"
import { BrowserClickTool } from "../../src/tool/browser-click"
import { BrowserTypeTool } from "../../src/tool/browser-type"
import { BrowserWaitTool } from "../../src/tool/browser-wait"
import { BrowserScreenshotTool } from "../../src/tool/browser-screenshot"
import { BrowserExtractTool } from "../../src/tool/browser-extract"
import { SessionID, MessageID } from "../../src/session/schema"
import { FakeCdpServer, provideFakeHost, scriptCurrentUrl } from "../fake/cdp-server"

const askLog: Array<{ permission: string; patterns: string[] }> = []

const ctx = {
  sessionID: SessionID.make("ses_browser_tools"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input: { permission: string; patterns: string[] }) => {
    askLog.push({ permission: input.permission, patterns: input.patterns })
    return Effect.void
  },
}

const projectRoot = path.join(import.meta.dir, "../..")

// Loose tool type: each browser tool has its own Parameters schema, and this
// helper only needs init/execute.
type AnyToolEffect = Effect.Effect<Tool.Info<Schema.Decoder<unknown>, Record<string, unknown>>, never, never>

function exec(tool: unknown, args: unknown) {
  return Instance.provide({
    directory: projectRoot,
    fn: () =>
      (tool as AnyToolEffect).pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((t) => t.execute(args as never, ctx as never)),
        Effect.provide(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer)),
        Effect.runPromise,
      ),
  })
}

let servers: FakeCdpServer[] = []
function makeServer(): FakeCdpServer {
  const server = new FakeCdpServer()
  servers.push(server)
  return server
}

/** Standard happy-path fake: blank page, scripted evaluate. */
function setupServer(): FakeCdpServer {
  const server = makeServer()
  scriptCurrentUrl(server, "about:blank")
  provideFakeHost(server)
  return server
}

afterEach(async () => {
  resetBrowserSessionsForTest()
  BrowserBridge.provideHost(null)
  for (const server of servers) await server.close()
  servers = []
  askLog.length = 0
})

describe("browser_navigate", () => {
  test("rejects non-web schemes before any permission ask or navigation", async () => {
    setupServer()
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "example.com"]) {
      await expect(exec(BrowserNavigateTool, { url })).rejects.toThrow(/Not a navigable URL/)
    }
    expect(askLog).toEqual([])
  })

  test("navigates, asks the browser permission with the URL, and reports the landed page", async () => {
    const server = setupServer()
    const result = await exec(BrowserNavigateTool, { url: "https://example.com/page" })
    expect(server.methods).toContain("Page.navigate")
    expect(result.output).toContain("Loaded https://example.com/page")
    expect(askLog).toEqual([{ permission: "browser", patterns: ["https://example.com/page"] }])
  })
})

describe("browser_snapshot", () => {
  test("returns the page's ref tree as text", async () => {
    const server = makeServer()
    // snapshot() runs in-page JS through Runtime.evaluate; return the ref tree.
    server.handlers.set("Runtime.evaluate", () => ({
      result: { type: "string", value: "[1] <button> Submit\n[2] <a> Home" },
    }))
    provideFakeHost(server)
    const result = await exec(BrowserSnapshotTool, {})
    expect(result.output).toContain("[1] <button> Submit")
    expect(askLog[0]?.permission).toBe("browser")
  })
})

describe("browser_click", () => {
  test("reports the self-verification outcome", async () => {
    const server = setupServer()
    // click runs several in-page steps (resolve → bounding rect → click); one
    // combined object satisfies each step's reads.
    server.handlers.set("Runtime.evaluate", () => ({
      result: {
        type: "object",
        value: { ok: true, matches_n: 1, match_level: "exact", visible: true, x: 10, y: 10 },
      },
    }))
    const result = await exec(BrowserClickTool, { ref: "[1]" })
    expect(result.output).toContain("Clicked [1]")
    expect(result.metadata?.matches).toBe(1)
  })
})

describe("browser_type", () => {
  test("fills, optionally submits, and reports verification", async () => {
    const server = setupServer()
    // fillText runs resolve → prepare → (native type) → verify in-page; one
    // combined object satisfies each step's reads.
    server.handlers.set("Runtime.evaluate", () => ({
      result: {
        type: "object",
        value: { ok: true, matches_n: 1, match_level: "exact", actual: "hello", mode: "input" },
      },
    }))
    const result = await exec(BrowserTypeTool, { ref: "[2]", text: "hello", submit: true })
    expect(result.output).toContain("pressed Enter")
    expect(result.metadata?.verified).toBe(true)
    expect(server.methods).toContain("Input.dispatchKeyEvent")
  })
})

describe("browser_wait", () => {
  test("requires exactly one condition", async () => {
    setupServer()
    await expect(exec(BrowserWaitTool, {})).rejects.toThrow(/exactly one/)
    await expect(exec(BrowserWaitTool, { text: "a", selector: "b" })).rejects.toThrow(/exactly one/)
    expect(askLog).toEqual([])
  })

  test("waits for a fixed pause", async () => {
    setupServer()
    const result = await exec(BrowserWaitTool, { time: 0.05 })
    expect(result.output).toContain("Done")
  })
})

describe("browser_screenshot", () => {
  test("returns the capture as a PNG attachment", async () => {
    const server = setupServer()
    const pixel =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    server.handlers.set("Page.captureScreenshot", () => ({ data: pixel }))
    const result = await exec(BrowserScreenshotTool, {})
    expect(result.attachments?.length).toBe(1)
    expect(result.attachments?.[0].mime).toBe("image/png")
    expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
  })
})

describe("browser_extract", () => {
  test("converts page HTML to markdown", async () => {
    const server = setupServer()
    server.handlers.set("Runtime.evaluate", () => ({
      result: { type: "string", value: "<h1>Hello</h1><p>World with <a href='https://example.com'>link</a></p>" },
    }))
    const result = await exec(BrowserExtractTool, {})
    expect(result.output).toContain("Hello")
    expect(result.output).toContain("[link](https://example.com)")
  })

  test("pages long content through start/next_start_char", async () => {
    const server = setupServer()
    const long = `<p>${"word ".repeat(8000)}</p>`
    server.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: long } }))
    const first = await exec(BrowserExtractTool, {})
    expect(first.metadata?.next_start_char).toBeGreaterThan(0)
    const second = await exec(BrowserExtractTool, { start: first.metadata?.next_start_char as number })
    expect((second.output as string).length).toBeGreaterThan(0)
  })

  test("errors clearly when the selector matches nothing", async () => {
    const server = setupServer()
    server.handlers.set("Runtime.evaluate", () => ({ result: { type: "object", value: null } }))
    await expect(exec(BrowserExtractTool, { selector: "#missing" })).rejects.toThrow(/No element matches/)
  })
})
