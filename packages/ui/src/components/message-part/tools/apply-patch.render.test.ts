import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createRequire } from "module"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

const require = createRequire(import.meta.url)
const solidWeb = require.resolve("solid-js/web/dist/web.js")
const solidCore = require.resolve("solid-js/dist/solid.js")
const solidStore = require.resolve("solid-js/store/dist/store.js")

let server: ViteDevServer | undefined
let registeredDom = false
let rafCallbacks: Array<FrameRequestCallback | undefined> = []

const flushAnimationFrames = () => {
  const callbacks = rafCallbacks
  rafCallbacks = []
  callbacks.forEach((callback) => callback?.(performance.now()))
}

beforeAll(async () => {
  if (typeof document === "undefined" || typeof window === "undefined") {
    GlobalRegistrator.register()
    registeredDom = true
  }
  window.requestAnimationFrame = globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    rafCallbacks.push(callback)
    return rafCallbacks.length
  }) as typeof requestAnimationFrame
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame = ((id: number) => {
    rafCallbacks[id - 1] = undefined
  }) as typeof cancelAnimationFrame

  server = await createServer({
    root: new URL("../../../..", import.meta.url).pathname,
    configFile: false,
    plugins: [solidPlugin({ solid: { generate: "dom" } })],
    resolve: {
      alias: {
        "solid-js/web": solidWeb,
        "solid-js/store": solidStore,
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
  rafCallbacks = []
})

afterAll(async () => {
  await server?.close()
  if (registeredDom) GlobalRegistrator.unregister()
})

async function loadFixture(): Promise<typeof import("../../../../test/fixtures/apply-patch-render.fixture")> {
  if (!server) throw new Error("Vite server not initialized")
  return (await server.ssrLoadModule(
    "/test/fixtures/apply-patch-render.fixture.tsx",
  )) as typeof import("../../../../test/fixtures/apply-patch-render.fixture")
}

test("keeps the same BasicTool shell when apply_patch metadata grows from empty to one file", async () => {
  const { mountApplyPatchTool, patchFile } = await loadFixture()
  const tool = mountApplyPatchTool([])

  const collapsibleBefore = tool.collapsible()
  const contentBefore = tool.content()
  expect(collapsibleBefore).not.toBeNull()
  expect(contentBefore).not.toBeNull()

  tool.setFiles([patchFile()])
  await Promise.resolve()
  flushAnimationFrames()
  await Promise.resolve()

  expect(tool.collapsible()).toBe(collapsibleBefore)
  expect(tool.content()).toBe(contentBefore)

  tool.dispose()
})
