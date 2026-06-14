import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { Instance } from "../../src/project/instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"
import type * as Tool from "../../src/tool/tool"
import { provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const projectRoot = path.join(import.meta.dir, "../..")
const it = testEffect(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer))

afterEach(async () => {
  await Instance.disposeAll()
})

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

const withFetch = <A, E, R>(
  fetch: (req: Request) => Response | Promise<Response>,
  self: (url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, fetch })),
    (server) => Effect.promise(() => server.stop(true)),
  ).pipe(
    Effect.flatMap((server) => self(server.url)),
    Effect.scoped,
  )

const init = Effect.fn("WebFetchToolTest.init")(function* () {
  const info = yield* WebFetchTool
  return yield* info.init()
})

const run = Effect.fn("WebFetchToolTest.run")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("WebFetchToolTest.exec")(function* (
  args: Tool.InferParameters<typeof WebFetchTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(projectRoot)(run(args, next))
})

const fetchUrl = Effect.fn("WebFetchToolTest.fetchUrl")(function* (
  fetch: (req: Request) => Response | Promise<Response>,
  pathname: string,
  format: Tool.InferParameters<typeof WebFetchTool>["format"],
) {
  return yield* withFetch(fetch, (url) => exec({ url: new URL(pathname, url).toString(), format }))
})

describe("tool.webfetch", () => {
  it.live("returns image responses as file attachments", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const result = yield* fetchUrl(
        () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
        "/image.png",
        "markdown",
      )
      expect(result.output).toBe("Image fetched successfully")
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0].type).toBe("file")
      expect(result.attachments?.[0].mime).toBe("image/png")
      expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
    }),
  )

  it.live("keeps svg as text output", () =>
    Effect.gen(function* () {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
      const result = yield* fetchUrl(
        () =>
          new Response(svg, {
            status: 200,
            headers: { "content-type": "image/svg+xml; charset=UTF-8" },
          }),
        "/image.svg",
        "html",
      )
      expect(result.output).toContain("<svg")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.live("keeps text responses as text output", () =>
    Effect.gen(function* () {
      const result = yield* fetchUrl(
        () =>
          new Response("hello from webfetch", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        "/file.txt",
        "text",
      )
      expect(result.output).toBe("hello from webfetch")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.live("extracts text from html responses requested as text", () =>
    Effect.gen(function* () {
      const html = [
        "<!doctype html>",
        "<html>",
        "<head>",
        "<title>ignored title</title>",
        "<style>.hidden { display: none }</style>",
        "<script>window.secret = 'nope'</script>",
        "</head>",
        "<body>",
        "<main>",
        "<h1>Korea visa center</h1>",
        '<p data-note="1 > 0">Bring passport &amp; application form.</p>',
        "</main>",
        "</body>",
        "</html>",
      ].join("")

      const result = yield* fetchUrl(
        () =>
          new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        "/page.html",
        "text",
      )
      expect(result.output).toContain("Korea visa center")
      expect(result.output).toContain("Bring passport & application form.")
      expect(result.output).not.toContain('0">')
      expect(result.output).not.toContain("window.secret")
      expect(result.output).not.toContain(".hidden")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.live("handles many unclosed skip tags without long synchronous processing", () =>
    Effect.gen(function* () {
      const html = `<body>${"<script>".repeat(50_000)}visible text</body>`

      const start = performance.now()
      const result = yield* fetchUrl(
        () =>
          new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        "/hostile.html",
        "text",
      )
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(500)
      expect(result.output).not.toContain("<script>")
    }),
  )

  it.live("handles unterminated tag openers without long synchronous processing", () =>
    Effect.gen(function* () {
      const html = `<body>${"<".repeat(50_000)}`

      const start = performance.now()
      const result = yield* fetchUrl(
        () =>
          new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        "/raw-open.html",
        "text",
      )
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(500)
      expect(result.output).toContain("<")
    }),
  )

  it.live("handles long whitespace runs without long synchronous normalization", () =>
    Effect.gen(function* () {
      const html = `<body>${"\r".repeat(50_000)}visible text</body>`

      const start = performance.now()
      const result = yield* fetchUrl(
        () =>
          new Response(html, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        "/whitespace.html",
        "text",
      )
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(500)
      expect(result.output).toBe("visible text")
    }),
  )
})
