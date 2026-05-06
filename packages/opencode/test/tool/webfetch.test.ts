import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { Instance } from "../../src/project/instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

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

async function withFetch(fetch: (req: Request) => Response | Promise<Response>, fn: (url: URL) => Promise<void>) {
  using server = Bun.serve({ port: 0, fetch })
  await fn(server.url)
}

function exec(args: { url: string; format: "text" | "markdown" | "html" }) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.webfetch", () => {
  test("returns image responses as file attachments", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await withFetch(
      () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          },
        })
      },
    )
  })

  test("keeps svg as text output", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    await withFetch(
      () =>
        new Response(svg, {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.svg", url).toString(), format: "html" })
            expect(result.output).toContain("<svg")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("keeps text responses as text output", async () => {
    await withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/file.txt", url).toString(), format: "text" })
            expect(result.output).toBe("hello from webfetch")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("extracts text from html responses requested as text", async () => {
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

    await withFetch(
      () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/page.html", url).toString(), format: "text" })
            expect(result.output).toContain("Korea visa center")
            expect(result.output).toContain("Bring passport & application form.")
            expect(result.output).not.toContain('0">')
            expect(result.output).not.toContain("window.secret")
            expect(result.output).not.toContain(".hidden")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("handles many unclosed skip tags without long synchronous processing", async () => {
    const html = `<body>${"<script>".repeat(50_000)}visible text</body>`

    await withFetch(
      () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const start = performance.now()
            const result = await exec({ url: new URL("/hostile.html", url).toString(), format: "text" })
            const elapsed = performance.now() - start

            expect(elapsed).toBeLessThan(500)
            expect(result.output).not.toContain("<script>")
          },
        })
      },
    )
  })
})
