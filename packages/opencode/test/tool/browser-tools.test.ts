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
import { normalizeElementRef } from "../../src/tool/browser-shared"
import { BrowserTypeTool } from "../../src/tool/browser-type"
import { BrowserWaitTool } from "../../src/tool/browser-wait"
import { BrowserScreenshotTool } from "../../src/tool/browser-screenshot"
import { BrowserExtractTool } from "../../src/tool/browser-extract"
import { SessionID, MessageID } from "../../src/session/schema"
import { Permission } from "../../src/permission"
import { ToolInfoTool } from "../../src/tool/tool-info"
import { FakeCdpServer, HANG, provideFakeHost, scriptCurrentUrl } from "../fake/cdp-server"

const askLog: Array<{ permission: string; patterns: string[]; always: string[] }> = []

const ctx = {
  sessionID: SessionID.make("ses_browser_tools"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input: { permission: string; patterns: string[]; always: string[] }) => {
    askLog.push({ permission: input.permission, patterns: input.patterns, always: input.always })
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

  test("the permission is judged against the session's own page, and the action runs in that same view", async () => {
    const own = makeServer()
    own.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[1] <button> Ok" } }))
    const resolved: string[] = []
    BrowserBridge.provideHost({
      probeSession: async () => ({ url: "https://allowed.example/page" }),
      resolveEndpoint: async ({ sessionID }) => {
        resolved.push(sessionID)
        return { cdpEndpoint: own.endpoint }
      },
      releaseSession: async () => {},
      disposeSession: async () => {},
    })

    const result = await exec(BrowserSnapshotTool, {})
    expect(result.output).toContain("[1] <button> Ok")
    expect(askLog).toEqual([
      { permission: "browser", patterns: ["https://allowed.example/page"], always: ["https://allowed.example/*"] },
    ])
    // Identity resolution: the endpoint is requested for the acting session
    // itself — there is no window pick that focus could retarget.
    expect(resolved).toEqual([ctx.sessionID])
  })

  test("a failing probe fails the action before the ask, never a wildcard grant", async () => {
    const server = makeServer()
    BrowserBridge.provideHost({
      probeSession: async () => {
        throw Object.assign(new Error("The embedded browser is not available right now."), {
          code: "target-destroyed",
        })
      },
      resolveEndpoint: async () => ({ cdpEndpoint: server.endpoint }),
      releaseSession: async () => {},
      disposeSession: async () => {},
    })
    await expect(exec(BrowserSnapshotTool, {})).rejects.toThrow(/not available right now/)
    // A failed probe means no ask was ever judged and no CDP traffic flowed —
    // the action cannot ride a "*" grant past a probe it couldn't read.
    expect(askLog).toEqual([])
    expect(server.methods).toEqual([])
  })

  // The ask dialog can sit open while the user keeps browsing the view: by the
  // time they approve, the page may not be the one the permission was judged
  // against. A moved page is re-judged with a second ask against the URL as it
  // is now — full-URL granularity, so path-scoped rules get their say too.
  test("an approval granted on one page is re-judged when the page moved — a deny on the landing wins", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "https://asked.example/page")
    provideFakeHost(server)
    const movingCtx = {
      ...ctx,
      ask: (input: { permission: string; patterns: string[]; always: string[] }) => {
        askLog.push({ permission: input.permission, patterns: input.patterns, always: input.always })
        if (input.patterns.some((p) => p.includes("other.example"))) return Effect.fail(new Permission.RejectedError())
        server.url = "https://other.example/landing"
        return Effect.void
      },
    } as unknown as typeof ctx
    await expect(execWith(movingCtx, BrowserSnapshotTool, {})).rejects.toThrow(/rejected permission/)
    expect(askLog.map((a) => a.patterns)).toEqual([["https://asked.example/page"], ["https://other.example/landing"]])
    expect(server.methods).toEqual([])
  })

  test("a same-origin move onto a path the rules deny cannot ride the original approval", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "https://asked.example/safe")
    provideFakeHost(server)
    // permission.browser-style path rule: /admin/* is denied, the rest allowed.
    const pathDenyCtx = {
      ...ctx,
      ask: (input: { permission: string; patterns: string[]; always: string[] }) => {
        askLog.push({ permission: input.permission, patterns: input.patterns, always: input.always })
        if (input.patterns.some((p) => p.startsWith("https://asked.example/admin/")))
          return Effect.fail(new Permission.RejectedError())
        server.url = "https://asked.example/admin/users"
        return Effect.void
      },
    } as unknown as typeof ctx
    await expect(execWith(pathDenyCtx, BrowserSnapshotTool, {})).rejects.toThrow(/rejected permission/)
    expect(server.methods).toEqual([])
  })

  test("a benign same-site move passes the re-judge and the action runs", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "https://asked.example/a")
    provideFakeHost(server)
    server.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: "[1] <button> Ok" } }))
    const movingCtx = {
      ...ctx,
      ask: (input: { permission: string; patterns: string[]; always: string[] }) => {
        askLog.push({ permission: input.permission, patterns: input.patterns, always: input.always })
        server.url = "https://asked.example/b"
        return Effect.void
      },
    } as unknown as typeof ctx
    const result = await execWith(movingCtx, BrowserSnapshotTool, {})
    expect(result.output).toContain("[1] <button> Ok")
    expect(askLog.map((a) => a.patterns)).toEqual([["https://asked.example/a"], ["https://asked.example/b"]])
  })

  test("a partially available browser group activates only the available members", async () => {
    // The registry filters deferred tools per member, so the activation must
    // announce the same subset — never a member the next step's tool list
    // won't contain.
    const partialCtx = {
      ...ctx,
      extra: { deferredAvailable: (id: string) => id !== "browser_screenshot" },
    } as unknown as typeof ctx
    const result = await execWith(partialCtx, ToolInfoTool(() => Effect.void), { name: "browser" })
    expect(result.output).toContain('<tool_info name="browser_snapshot">')
    expect(result.output).not.toContain("browser_screenshot")
    expect(result.metadata?.activated).toBe("browser")
    expect(result.metadata?.members).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_wait",
      "browser_extract",
    ])
  })

  test("a browser group with no available members fails activation", async () => {
    const noneCtx = { ...ctx, extra: { deferredAvailable: () => false } } as unknown as typeof ctx
    await expect(execWith(noneCtx, ToolInfoTool(() => Effect.void), { name: "browser" })).rejects.toThrow(
      /not available in this context/,
    )
  })

  // NOTE: "connection died while idle, next action self-heals" lives in
  // session.test.ts (timeout-severs and bridge-drop invalidation cover the
  // same path); it cannot be exercised through real tools here because bun's
  // ws shim delivers no close callback, so the next send hangs into the 25s
  // tool timeout instead of failing locally.
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
    expect(askLog).toEqual([
      { permission: "browser", patterns: ["https://example.com/page"], always: ["https://example.com/*"] },
    ])
  })

  test("a redirect's real landing is reported and re-judged, not the requested URL", async () => {
    const server = makeServer()
    provideFakeHost(server)
    // The site redirects: the document's location reads differently from the
    // requested URL (goto's own cache would just echo the request back).
    server.handlers.set("Runtime.evaluate", () => ({
      result: { type: "string", value: "https://ok.example/final" },
    }))
    const result = await exec(BrowserNavigateTool, { url: "https://ok.example/start" })
    expect(result.output).toContain("Loaded https://ok.example/final")
    expect(askLog).toEqual([
      { permission: "browser", patterns: ["https://ok.example/start"], always: ["https://ok.example/*"] },
      { permission: "browser", patterns: ["https://ok.example/final"], always: ["https://ok.example/*"] },
    ])
  })

  test("a cross-site redirect onto a denied site fails the navigate", async () => {
    const server = makeServer()
    provideFakeHost(server)
    server.handlers.set("Runtime.evaluate", () => ({
      result: { type: "string", value: "https://blocked.example/landing" },
    }))
    // The user's rules deny blocked.example; the requested site is fine. The
    // permission was granted for the request, so the landing must be re-judged
    // or the deny is bypassed by a redirect.
    const denyBlocked = {
      ...ctx,
      ask: (input: { permission: string; patterns: string[]; always: string[] }) => {
        askLog.push({ permission: input.permission, patterns: input.patterns, always: input.always })
        return input.patterns.some((p) => new URL(p).hostname === "blocked.example")
          ? Effect.fail(new Permission.RejectedError())
          : Effect.void
      },
    } as unknown as typeof ctx
    await expect(execWith(denyBlocked, BrowserNavigateTool, { url: "https://ok.example/start" })).rejects.toThrow(
      /rejected permission/,
    )
    expect(askLog).toEqual([
      { permission: "browser", patterns: ["https://ok.example/start"], always: ["https://ok.example/*"] },
      { permission: "browser", patterns: ["https://blocked.example/landing"], always: ["https://blocked.example/*"] },
    ])
    // The deny here is a SOFT contract: the navigation had already committed
    // when the landing was re-judged (vetoing a redirect before it loads needs
    // request-phase CDP interception — a documented follow-up). What the deny
    // guarantees is that the action fails loudly and later actions re-probe
    // the denied page; it does not prevent the document from loading.
    expect(server.methods).toContain("Page.navigate")
  })
})

describe("cancellation", () => {
  test("user stop aborts a hung action fast and severs the connection", async () => {
    const server = makeServer()
    scriptCurrentUrl(server, "about:blank")
    const { released } = provideFakeHost(server)
    // Warm the connection so the hang hits the action itself, not the connect.
    await exec(BrowserSnapshotTool, {})
    server.handlers.set("Runtime.evaluate", HANG)

    const controller = new AbortController()
    const abortCtx = { ...ctx, abort: controller.signal } as typeof ctx
    const pending = execWith(abortCtx, BrowserClickTool, { ref: "[1]" })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toThrow(/canceled/)
    // Severing is what makes the cancel real: CDP has no command-level
    // cancel, so only a closed socket guarantees the orphaned click can
    // never land on the page after the user hit stop.
    expect(released).toContain("ses_browser_tools")
  }, 10_000)
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
    // A blank/non-web page has no origin to scope an "always" grant to — the
    // ask offers none rather than a global one.
    expect(askLog[0]?.always).toEqual([])
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
    expect(askLog).toEqual([
      { permission: "browser", patterns: ["https://example.com/page"], always: ["https://example.com/*"] },
    ])
  })
})

describe("browser_click", () => {
  test("reports the self-verification outcome", async () => {
    const server = setupServer()
    // click runs several in-page steps (resolve → bounding rect → click); one
    // combined object satisfies each step's reads.
    const expressions: string[] = []
    server.handlers.set("Runtime.evaluate", (params) => {
      expressions.push((params as { expression?: string })?.expression ?? "")
      return {
        result: {
          type: "object",
          value: { ok: true, matches_n: 1, match_level: "exact", visible: true, x: 10, y: 10 },
        },
      }
    })
    const result = await exec(BrowserClickTool, { ref: "[1]" })
    expect(result.output).toContain("Clicked [1]")
    expect(result.metadata?.matches).toBe(1)
    // opencli's resolver treats only a bare number as a snapshot ref: "[1]"
    // must be normalized before it reaches the page or it parses as a CSS
    // selector and fails.
    expect(expressions.join("\n")).toContain('const ref = "1"')
    expect(expressions.join("\n")).not.toContain('"[1]"')
  })
})

describe("normalizeElementRef", () => {
  test("maps the snapshot spelling to opencli's bare-number ref and leaves selectors alone", () => {
    expect(normalizeElementRef("[12]")).toBe("12")
    expect(normalizeElementRef(" [12] ")).toBe("12")
    expect(normalizeElementRef("12")).toBe("12")
    expect(normalizeElementRef("a[href]")).toBe("a[href]")
    expect(normalizeElementRef("[data-x]")).toBe("[data-x]")
    expect(normalizeElementRef("#main [12]")).toBe("#main [12]")
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

  test("a wait that is the takeover's first action surfaces the reload note once", async () => {
    const server = makeServer()
    // The user already had a page open: connecting reloads it for stealth,
    // and a wait whose condition was met on that fresh document must say so.
    server.url = "https://example.com/already-open"
    scriptCurrentUrl(server, "https://example.com/already-open")
    provideFakeHost(server)

    const first = await exec(BrowserWaitTool, { time: 0.05 })
    expect(first.output).toContain("reloaded once")
    const second = await exec(BrowserWaitTool, { time: 0.05 })
    expect(second.output).not.toContain("reloaded once")
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
  function scriptPageHtml(server: FakeCdpServer, html: string, truncated = false) {
    server.handlers.set("Runtime.evaluate", () => ({ result: { type: "object", value: { html, truncated } } }))
  }

  test("converts page HTML to markdown", async () => {
    const server = setupServer()
    scriptPageHtml(server, "<h1>Hello</h1><p>World with <a href='https://example.com'>link</a></p>")
    const result = await exec(BrowserExtractTool, {})
    expect(result.output).toContain("Hello")
    expect(result.output).toContain("[link](https://example.com)")
    expect(result.metadata?.html_truncated).toBeUndefined()
  })

  test("pages long content through start/next_start_char", async () => {
    const server = setupServer()
    scriptPageHtml(server, `<p>${"word ".repeat(8000)}</p>`)
    const first = await exec(BrowserExtractTool, {})
    expect(first.metadata?.next_start_char).toBeGreaterThan(0)
    const second = await exec(BrowserExtractTool, { start: first.metadata?.next_start_char as number })
    expect((second.output as string).length).toBeGreaterThan(0)
  })

  test("reports when the page-side HTML ceiling dropped trailing content", async () => {
    const server = setupServer()
    // The page-side script capped the HTML before it crossed CDP; the tool
    // must say so instead of presenting a silently incomplete page.
    scriptPageHtml(server, "<p>visible part</p>", true)
    const result = await exec(BrowserExtractTool, {})
    expect(result.output).toContain("visible part")
    expect(result.output).toContain("larger than the extraction ceiling")
    expect(result.metadata?.html_truncated).toBe(true)
  })

  test("errors clearly when the selector matches nothing", async () => {
    const server = setupServer()
    server.handlers.set("Runtime.evaluate", () => ({ result: { type: "object", value: null } }))
    await expect(exec(BrowserExtractTool, { selector: "#missing" })).rejects.toThrow(/No element matches/)
  })
})
