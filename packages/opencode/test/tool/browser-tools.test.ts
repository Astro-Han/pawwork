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
import { Permission } from "../../src/permission"
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

function execWith(customCtx: typeof ctx, tool: unknown, args: unknown) {
  return Instance.provide({
    directory: projectRoot,
    fn: () =>
      (tool as AnyToolEffect).pipe(
        Effect.flatMap((info) => info.init()),
        Effect.flatMap((t) => t.execute(args as never, customCtx as never)),
        Effect.provide(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer)),
        Effect.runPromise,
      ),
  })
}

function exec(tool: unknown, args: unknown) {
  return execWith(ctx, tool, args)
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

describe("permission gate", () => {
  test("a denied permission leaves the user's already-open page completely untouched", async () => {
    const server = makeServer()
    // The user already has a page open; a deny must not connect, register the
    // stealth script, or reload it — the probe reads main-process state only.
    server.url = "https://example.com/already-open"
    provideFakeHost(server)
    const denyCtx = { ...ctx, ask: () => Effect.fail(new Permission.RejectedError()) } as unknown as typeof ctx
    const calls: Array<[unknown, unknown]> = [
      [BrowserNavigateTool, { url: "https://example.com/next" }],
      [BrowserSnapshotTool, {}],
      [BrowserClickTool, { ref: "[1]" }],
      [BrowserTypeTool, { ref: "[1]", text: "x", submit: true }],
      [BrowserWaitTool, { text: "done" }],
      [BrowserScreenshotTool, {}],
      [BrowserExtractTool, {}],
    ]
    for (const [tool, args] of calls) {
      await expect(execWith(denyCtx, tool, args)).rejects.toThrow(/rejected permission/)
    }
    expect(server.methods).toEqual([])
  })

  test("the action runs in the window the permission was granted for, not where focus moved", async () => {
    const allowed = makeServer()
    allowed.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[1] <button> Ok" } }))
    const denied = makeServer()
    const resolved: Array<number | undefined> = []
    BrowserBridge.provideHost({
      // The probe reads the allowed window (id 7); by attach time focus moved,
      // so an un-leased resolve would land on the denied window instead.
      probeWindow: async () => ({ windowID: 7, url: "https://allowed.example/page" }),
      resolveEndpoint: async ({ windowID }) => {
        resolved.push(windowID)
        return { cdpEndpoint: windowID === 7 ? allowed.endpoint : denied.endpoint }
      },
      releaseSession: async () => {},
    })

    const result = await exec(BrowserSnapshotTool, {})
    expect(result.output).toContain("[1] <button> Ok")
    expect(askLog).toEqual([{ permission: "browser", patterns: ["https://allowed.example/page"] }])
    // The lease pinned the attach to the probed window; the other window saw nothing.
    expect(resolved).toEqual([7])
    expect(denied.methods).toEqual([])
  })

  test("no serveable window fails the action before the ask, never a wildcard grant", async () => {
    const server = makeServer()
    BrowserBridge.provideHost({
      probeWindow: async () => {
        throw Object.assign(new Error("No PawWork window is open to host the embedded browser."), {
          code: "no-window",
        })
      },
      resolveEndpoint: async () => ({ cdpEndpoint: server.endpoint }),
      releaseSession: async () => {},
    })
    await expect(exec(BrowserSnapshotTool, {})).rejects.toThrow(/No PawWork window/)
    // Failing the lease means no ask was ever judged and no CDP traffic flowed —
    // the action cannot ride a "*" grant onto whatever window focus lands on.
    expect(askLog).toEqual([])
    expect(server.methods).toEqual([])
  })

  test("navigate attaches the leased window even when focus moved during the ask", async () => {
    const leased = makeServer()
    leased.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "Title" } }))
    const focused = makeServer()
    const resolved: Array<number | undefined> = []
    BrowserBridge.provideHost({
      probeWindow: async () => ({ windowID: 1, url: null }),
      resolveEndpoint: async ({ windowID }) => {
        resolved.push(windowID)
        return { cdpEndpoint: windowID === 1 ? leased.endpoint : focused.endpoint }
      },
      releaseSession: async () => {},
    })

    await exec(BrowserNavigateTool, { url: "https://example.com/dest" })
    // The permission stays scoped to the destination; the lease only pins WHERE it runs.
    expect(askLog).toEqual([{ permission: "browser", patterns: ["https://example.com/dest"] }])
    expect(resolved).toEqual([1])
    expect(leased.methods).toContain("Page.navigate")
    expect(focused.methods).toEqual([])
  })

  test("concurrent first actions leased to different windows never share a connection", async () => {
    const winOne = makeServer()
    winOne.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[1] <button> Ok" } }))
    const winTwo = makeServer()
    const resolved: Array<number | undefined> = []
    // The window landscape moves between the two probes: each action leases a
    // different window and asks against that window's URL.
    const probes = [
      { windowID: 1, url: "https://example.com/win-1" },
      { windowID: 2, url: "https://example.com/win-2" },
    ]
    BrowserBridge.provideHost({
      probeWindow: async () => probes.shift()!,
      resolveEndpoint: async ({ windowID }) => {
        resolved.push(windowID)
        // Keep the first acquire in flight so the second action arrives while
        // it is still pending.
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { cdpEndpoint: windowID === 1 ? winOne.endpoint : winTwo.endpoint }
      },
      releaseSession: async () => {},
    })

    const first = exec(BrowserSnapshotTool, {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = exec(BrowserSnapshotTool, {})

    // The second action's permission was granted for window 2; joining the
    // pending window-1 acquire would run it where that grant never applied.
    await expect(second).rejects.toThrow(/window for this session changed/)
    await expect(first).resolves.toMatchObject({ output: expect.stringContaining("[1] <button> Ok") })
    expect(askLog).toEqual([
      { permission: "browser", patterns: ["https://example.com/win-1"] },
      { permission: "browser", patterns: ["https://example.com/win-2"] },
    ])
    expect(resolved).toEqual([1])
    expect(winTwo.methods).toEqual([])
  }, 10_000)

  test("an action recovers when the session's window closed while idle", async () => {
    const winOne = makeServer()
    winOne.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[1] <button> One" } }))
    const winTwo = makeServer()
    winTwo.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[2] <button> Two" } }))
    // Window 1 closes while nothing is in flight, so the dead connection is
    // never noticed; the host's probe then leases the surviving window 2.
    const probes = [
      { windowID: 1, url: null },
      { windowID: 2, url: null },
      { windowID: 2, url: null },
    ]
    BrowserBridge.provideHost({
      probeWindow: async () => probes.shift()!,
      resolveEndpoint: async ({ windowID }) => ({ cdpEndpoint: windowID === 2 ? winTwo.endpoint : winOne.endpoint }),
      releaseSession: async () => {},
    })

    const first = await exec(BrowserSnapshotTool, {})
    expect(first.output).toContain("[1] <button> One")

    // The mismatch drops the stale window-1 connection along with the error,
    // so the retry the message asks for actually converges on window 2.
    await expect(exec(BrowserSnapshotTool, {})).rejects.toThrow(/window for this session changed/)
    const retried = await exec(BrowserSnapshotTool, {})
    expect(retried.output).toContain("[2] <button> Two")
  })
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

  test("scopes the permission to the page's current URL, not '*'", async () => {
    const server = setupServer()
    // navigate moves the window's webContents URL; the next action's permission
    // must ask against that URL (URL-scoped rules decide per site). The probe
    // reads main-process view state, never the CDP connection.
    await exec(BrowserNavigateTool, { url: "https://example.com/page" })
    server.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[1] <button> Go" } }))
    askLog.length = 0
    const result = await exec(BrowserSnapshotTool, {})
    expect(result.output).toContain("[1] <button> Go")
    expect(askLog).toEqual([{ permission: "browser", patterns: ["https://example.com/page"] }])
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

  test("rejects blank text/selector before any permission ask or wait", async () => {
    const server = setupServer()
    await expect(exec(BrowserWaitTool, { text: "" })).rejects.toThrow(/non-empty/)
    await expect(exec(BrowserWaitTool, { selector: "" })).rejects.toThrow(/non-empty/)
    await expect(exec(BrowserWaitTool, { text: "   " })).rejects.toThrow(/non-empty/)
    expect(askLog).toEqual([])
    expect(server.methods).toEqual([])
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
