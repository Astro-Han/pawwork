import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { Instance } from "../../src/project/instance"
import { BrowserBridge } from "../../src/tool/browser/bridge"
import {
  BrowserClickTool,
  BrowserExtractTool,
  BrowserNavigateTool,
  BrowserScreenshotTool,
  BrowserTypeTool,
  BrowserWaitTool,
} from "../../src/tool/browser/tools"
import { MessageID, SessionID } from "../../src/session/schema"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// A bridge stub that records the last input so each test can assert what the tool
// forwarded, then returns a canned result. Tests register the slice they need.
function stubBridge(overrides: Partial<BrowserBridge.Impl>): { calls: Record<string, unknown> } {
  const calls: Record<string, unknown> = {}
  const record =
    <K extends keyof BrowserBridge.Impl>(key: K, fn: BrowserBridge.Impl[K]): BrowserBridge.Impl[K] =>
    ((input: never) => {
      calls[key] = input
      return (fn as (i: never) => unknown)(input)
    }) as BrowserBridge.Impl[K]
  const base: BrowserBridge.Impl = {
    navigate: async () => ({ url: "about:blank", title: "" }),
    screenshot: async () => ({ mime: "image/png", base64: "", width: 0, height: 0 }),
    extract: async () => ({ url: "about:blank", title: "", text: "", truncated: false }),
    waitFor: async () => ({ found: false, waitedMs: 0, reason: "timeout" }),
    click: async () => ({ matched: false, x: 0, y: 0 }),
    type: async () => ({ matched: false, submitted: false }),
  }
  const merged = { ...base, ...overrides } as BrowserBridge.Impl
  const wrapped: BrowserBridge.Impl = {
    navigate: record("navigate", merged.navigate),
    screenshot: record("screenshot", merged.screenshot),
    extract: record("extract", merged.extract),
    waitFor: record("waitFor", merged.waitFor),
    click: record("click", merged.click),
    type: record("type", merged.type),
  }
  BrowserBridge.register(wrapped)
  return { calls }
}

function exec<P>(tool: typeof BrowserNavigateTool | any, args: P) {
  return Instance.provide({
    directory: projectRoot,
    fn: () =>
      tool.pipe(
        Effect.flatMap((info: any) => info.init()),
        Effect.flatMap((t: any) => t.execute(args, ctx)),
        Effect.provide(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer)),
        Effect.runPromise,
      ),
  })
}

afterEach(() => BrowserBridge.unregister())

describe("tool.browser", () => {
  test("is unavailable when no implementation is registered", async () => {
    expect(BrowserBridge.available()).toBe(false)
    await expect(exec(BrowserScreenshotTool, {})).rejects.toThrow()
  })

  test("navigate forwards the url and reports the landed page", async () => {
    const { calls } = stubBridge({ navigate: async ({ url }) => ({ url: `${url}/`, title: "Example" }) })
    const result = await exec(BrowserNavigateTool, { url: "https://example.com" })
    expect(calls.navigate).toEqual({ url: "https://example.com" })
    expect(result.output).toContain("https://example.com/")
    expect(result.output).toContain("Example")
    expect(result.metadata).toMatchObject({ url: "https://example.com/", pageTitle: "Example" })
  })

  test("navigate rejects a non-web url before touching the bridge", async () => {
    stubBridge({})
    await expect(exec(BrowserNavigateTool, { url: "file:///etc/passwd" })).rejects.toThrow()
  })

  test("screenshot returns a base64 png file attachment", async () => {
    stubBridge({ screenshot: async () => ({ mime: "image/png", base64: "QUJD", width: 800, height: 600 }) })
    const result = await exec(BrowserScreenshotTool, {})
    expect(result.output).toContain("800")
    expect(result.output).toContain("600")
    expect(result.attachments?.length).toBe(1)
    expect(result.attachments?.[0].type).toBe("file")
    expect(result.attachments?.[0].mime).toBe("image/png")
    expect(result.attachments?.[0].url).toBe("data:image/png;base64,QUJD")
    expect(result.attachments?.[0]).not.toHaveProperty("id")
    expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
  })

  test("extract clamps maxChars and surfaces the truncated flag", async () => {
    const { calls } = stubBridge({
      extract: async ({ maxChars }) => ({
        url: "https://a/",
        title: "A",
        text: "body text",
        truncated: maxChars < 100,
      }),
    })
    const result = await exec(BrowserExtractTool, { maxChars: 5 })
    expect(calls.extract).toMatchObject({ maxChars: 5 })
    expect(result.output).toBe("body text")
    expect(result.metadata).toMatchObject({ truncated: true })
  })

  test("wait requires a selector or text", async () => {
    stubBridge({})
    await expect(exec(BrowserWaitTool, {})).rejects.toThrow()
  })

  test("wait reports a satisfied selector", async () => {
    stubBridge({ waitFor: async () => ({ found: true, waitedMs: 120, reason: "selector" }) })
    const result = await exec(BrowserWaitTool, { selector: ".ready" })
    expect(result.title).toBe("Wait satisfied")
    expect(result.metadata).toMatchObject({ found: true, reason: "selector" })
  })

  test("click reports a match with coordinates", async () => {
    const { calls } = stubBridge({ click: async () => ({ matched: true, x: 12, y: 34 }) })
    const result = await exec(BrowserClickTool, { selector: "#go" })
    expect(calls.click).toEqual({ selector: "#go" })
    expect(result.output).toContain("(12, 34)")
    expect(result.metadata).toMatchObject({ matched: true })
  })

  test("click reports no match", async () => {
    stubBridge({ click: async () => ({ matched: false, x: 0, y: 0 }) })
    const result = await exec(BrowserClickTool, { selector: ".missing" })
    expect(result.title).toBe("No match")
    expect(result.metadata).toMatchObject({ matched: false })
  })

  test("type forwards text and submit and reports submission", async () => {
    const { calls } = stubBridge({ type: async () => ({ matched: true, submitted: true }) })
    const result = await exec(BrowserTypeTool, { selector: "#q", text: "hello", submit: true })
    expect(calls.type).toEqual({ selector: "#q", text: "hello", submit: true })
    expect(result.output).toContain("submitted")
    expect(result.metadata).toMatchObject({ matched: true, submitted: true })
  })
})
