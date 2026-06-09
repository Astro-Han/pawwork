import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createRequire } from "module"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

const require = createRequire(import.meta.url)
const solidWeb = require.resolve("solid-js/web/dist/web.js")
const solidCore = require.resolve("solid-js/dist/solid.js")

let server: ViteDevServer | undefined
let registeredDom = false

beforeAll(async () => {
  if (typeof document === "undefined" || typeof window === "undefined") {
    GlobalRegistrator.register()
    registeredDom = true
  }

  server = await createServer({
    root: new URL("../..", import.meta.url).pathname,
    configFile: false,
    plugins: [solidPlugin({ solid: { generate: "dom" } })],
    resolve: {
      alias: {
        "solid-js/web": solidWeb,
        "solid-js": solidCore,
      },
    },
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    ssr: { noExternal: ["@kobalte/core", "solid-js"] },
  })
})

beforeEach(() => {
  document.body.textContent = ""
})

afterAll(async () => {
  await server?.close()
  if (registeredDom) GlobalRegistrator.unregister()
})

async function loadFixture(): Promise<typeof import("../../test/fixtures/trow-block-render.fixture")> {
  if (!server) throw new Error("Vite server not initialized")
  return (await server.ssrLoadModule(
    "/test/fixtures/trow-block-render.fixture.tsx",
  )) as typeof import("../../test/fixtures/trow-block-render.fixture")
}

test("keeps the same body mounted when a single trow grows into a group", async () => {
  const { mountTrowBlock, tool } = await loadFixture()
  const block = mountTrowBlock([tool("first", "bash")])

  const bodyBefore = block.body()
  const firstToolBefore = block.tool("first")
  expect(bodyBefore).not.toBeNull()
  expect(firstToolBefore).not.toBeNull()

  block.setParts([tool("first", "bash"), tool("second", "grep")])
  await Promise.resolve()

  expect(block.details()?.open).toBe(true)
  expect(block.body()).toBe(bodyBefore)
  expect(block.tool("first")).toBe(firstToolBefore)
  expect(block.tool("second")?.textContent).toBe("second:done")

  block.dispose()
})

test("updates an existing trow row without remounting it", async () => {
  const { mountTrowBlock, tool } = await loadFixture()
  const block = mountTrowBlock([tool("first", "bash", "before")])

  const firstToolBefore = block.tool("first")
  expect(firstToolBefore?.textContent).toBe("first:before")

  block.setParts([tool("first", "bash", "after")])
  await Promise.resolve()

  expect(block.tool("first")).toBe(firstToolBefore)
  expect(block.tool("first")?.textContent).toBe("first:after")

  block.dispose()
})
