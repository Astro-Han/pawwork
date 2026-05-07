import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"
import { expectModelsSnapshotUnchanged, writeCurrentModelsFixture } from "./models-snapshot-fixture"

const root = path.join(import.meta.dir, "../..")
const distEntry = path.join(root, "dist", "node", "node.js")

describe("built node webfetch", () => {
  test("extracts text from html without relying on Bun HTMLRewriter", async () => {
    await withEmbeddedServerArtifactLock(async () => {
      await using tmp = await tmpdir()
      const modelsFixture = writeCurrentModelsFixture(root, tmp.path)
      const runtimeRoot = path.join(tmp.path, "runtime")
      const runtimeHome = path.join(runtimeRoot, "home")
      const isolatedEnv = {
        ...process.env,
        MODELS_DEV_API_JSON: modelsFixture.fixture,
        HOME: runtimeHome,
        USERPROFILE: runtimeHome,
        XDG_DATA_HOME: path.join(runtimeRoot, "share"),
        XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
        XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
        XDG_STATE_HOME: path.join(runtimeRoot, "state"),
        OPENCODE_TEST_HOME: runtimeHome,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(runtimeRoot, "managed"),
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DB: ":memory:",
      }

      await Promise.all(
        [
          isolatedEnv.HOME,
          isolatedEnv.XDG_DATA_HOME,
          isolatedEnv.XDG_CACHE_HOME,
          isolatedEnv.XDG_CONFIG_HOME,
          isolatedEnv.XDG_STATE_HOME,
          isolatedEnv.OPENCODE_TEST_MANAGED_CONFIG_DIR,
        ].map((dir) => fs.mkdir(dir, { recursive: true })),
      )

      await Process.run([process.execPath, "run", "build:embedded-server"], {
        cwd: root,
        env: isolatedEnv,
      })
      expectModelsSnapshotUnchanged(modelsFixture)

      const script = `
        import http from "node:http"
        import https from "node:https"
        import { Effect } from "effect"
        import { FetchHttpClient } from "effect/unstable/http"
        import { Instance, Log, ToolRegistry } from ${JSON.stringify(pathToFileURL(distEntry).href)}

        if (typeof HTMLRewriter !== "undefined") {
          throw new Error("test must run in a Node runtime without HTMLRewriter")
        }

        const directory = process.env.TEST_DIRECTORY
        if (!directory) throw new Error("missing TEST_DIRECTORY")

        await Log.init({ level: "DEBUG", print: false })

        const happyHTML = [
          "<!doctype html>",
          "<html>",
          "<head>",
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
        const hostileHTML = \`<body>\${"<script>".repeat(50_000)}visible text</body>\`
        const rawOpenHTML = \`<body>\${"<".repeat(50_000)}\`
        const whitespaceHTML = \`<body>\${"\\r".repeat(50_000)}visible text</body>\`

        // The test validates the built Node WebFetch parser path. Avoid Node
        // 24 Windows global fetch teardown, which can abort during process.exit().
        const nodeFetch = (input, init = {}) => new Promise((resolve, reject) => {
          const url = new URL(input instanceof Request ? input.url : input)
          const client = url.protocol === "https:" ? https : http
          const normalizeHeaders = (headers) => {
            if (!headers) return {}
            if (headers instanceof Headers || Array.isArray(headers)) return Object.fromEntries(headers)
            if (typeof headers[Symbol.iterator] === "function") return Object.fromEntries(headers)
            return headers
          }
          const headers = {
            ...(input instanceof Request ? Object.fromEntries(input.headers) : {}),
            ...normalizeHeaders(init.headers),
          }
          const req = client.request(
            url,
            {
              method: init.method ?? (input instanceof Request ? input.method : "GET"),
              headers: { ...headers, connection: "close" },
              agent: false,
              signal: init.signal,
            },
            (res) => {
              const chunks = []
              res.on("data", (chunk) => chunks.push(chunk))
              res.on("error", reject)
              res.on("end", () => {
                const responseHeaders = new Headers()
                for (const [key, value] of Object.entries(res.headers)) {
                  if (Array.isArray(value)) {
                    for (const item of value) responseHeaders.append(key, item)
                  } else if (value !== undefined) {
                    responseHeaders.set(key, value)
                  }
                }
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: res.statusCode ?? 200,
                    statusText: res.statusMessage,
                    headers: responseHeaders,
                  }),
                )
              })
            },
          )

          req.on("error", reject)
          if (init.signal?.aborted) req.destroy(init.signal.reason)
          req.end(init.body)
        })

        const sockets = new Set()
        const server = http.createServer((req, res) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" })
          res.end(
            req.url === "/hostile.html"
              ? hostileHTML
              : req.url === "/raw-open.html"
                ? rawOpenHTML
                : req.url === "/whitespace.html"
                  ? whitespaceHTML
                  : happyHTML,
            )
        })
        server.on("connection", (socket) => {
          sockets.add(socket)
          socket.on("close", () => sockets.delete(socket))
        })

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("missing server address")

        try {
          const output = await Instance.provide({
            directory,
            fn: async () => {
              const tools = await ToolRegistry.tools({
                providerID: "openai",
                modelID: "gpt-5",
                agent: { name: "build", mode: "primary", permission: [], options: {} },
              })
              const webfetch = tools.find((tool) => tool.id === "webfetch")
              if (!webfetch) throw new Error("missing webfetch tool")
              const run = async (pathname) => Effect.runPromise(
                webfetch.execute(
                  { url: \`http://127.0.0.1:\${address.port}\${pathname}\`, format: "text" },
                  {
                    sessionID: "ses_test",
                    messageID: "msg_test",
                    callID: "tool_test",
                    agent: "build",
                    abort: new AbortController().signal,
                    messages: [],
                    metadata: () => Effect.void,
                    ask: () => Effect.void,
                  },
                ).pipe(Effect.provideService(FetchHttpClient.Fetch, nodeFetch)),
              )

              const happy = await run("/page.html")
              const hostileStart = performance.now()
              const hostile = await run("/hostile.html")
              const rawOpenStart = performance.now()
              const rawOpen = await run("/raw-open.html")
              const whitespaceStart = performance.now()
              const whitespace = await run("/whitespace.html")
              return {
                happy: happy.output,
                hostile: hostile.output,
                hostileElapsed: performance.now() - hostileStart,
                rawOpen: rawOpen.output,
                rawOpenElapsed: performance.now() - rawOpenStart,
                whitespace: whitespace.output,
                whitespaceElapsed: performance.now() - whitespaceStart,
              }
            },
          })

          console.log(JSON.stringify(output))
        } finally {
          await Instance.disposeAll()
          await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
            server.closeAllConnections?.()
            for (const socket of sockets) socket.destroy()
          })
        }

        await new Promise((resolve) => setTimeout(resolve, 50))
        process.exit(0)
      `

      const result = await Process.run(["node", "--input-type=module", "-e", script], {
        cwd: root,
        env: {
          ...isolatedEnv,
          TEST_DIRECTORY: tmp.path,
        },
      })

      const output = JSON.parse(result.stdout.toString().trim()) as {
        happy: string
        hostile: string
        hostileElapsed: number
        rawOpen: string
        rawOpenElapsed: number
        whitespace: string
        whitespaceElapsed: number
      }
      expect(output.happy).toContain("Korea visa center")
      expect(output.happy).toContain("Bring passport & application form.")
      expect(output.happy).not.toContain('0">')
      expect(output.happy).not.toContain("window.secret")
      expect(output.happy).not.toContain(".hidden")
      expect(output.hostileElapsed).toBeLessThan(500)
      expect(output.hostile).not.toContain("<script>")
      expect(output.rawOpenElapsed).toBeLessThan(500)
      expect(output.rawOpen).toContain("<")
      expect(output.whitespaceElapsed).toBeLessThan(500)
      expect(output.whitespace).toBe("visible text")
    })
  }, 60_000)
})
