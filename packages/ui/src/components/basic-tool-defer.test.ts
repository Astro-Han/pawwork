import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createRequire } from "module"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"
import { basicToolInitialReady } from "./basic-tool"

const require = createRequire(import.meta.url)
const solidWeb = require.resolve("solid-js/web/dist/web.js")
const solidCore = require.resolve("solid-js/dist/solid.js")
const solidStore = require.resolve("solid-js/store/dist/store.js")

let server: ViteDevServer | undefined
let rafCallbacks: Array<FrameRequestCallback | undefined> = []
let registeredDom = false

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
    root: new URL("../..", import.meta.url).pathname,
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

async function loadFixture(): Promise<typeof import("../../test/fixtures/basic-tool-render.fixture")> {
  if (!server) throw new Error("Vite server not initialized")
  return (await server.ssrLoadModule(
    "/test/fixtures/basic-tool-render.fixture.tsx",
  )) as typeof import("../../test/fixtures/basic-tool-render.fixture")
}

test("deferred default-open tools mount details immediately", () => {
  expect(basicToolInitialReady({ defaultOpen: true, defer: true })).toBe(true)
})

test("deferred default-open tools render details without a zero-height frame", async () => {
  const { mountBasicTool } = await loadFixture()
  const tool = mountBasicTool({ defaultOpen: true, defer: true })

  await Promise.resolve()

  expect(tool.detailsRenderCount()).toBeGreaterThan(0)
  expect(tool.details()?.textContent).toBe("details")

  tool.dispose()
})

test("non-deferred default-open tools keep rendering details synchronously", async () => {
  const { mountBasicTool } = await loadFixture()
  const tool = mountBasicTool({ defaultOpen: true, defer: false })

  expect(tool.detailsRenderCount()).toBeGreaterThan(0)
  expect(tool.details()?.textContent).toBe("details")

  tool.dispose()
})

test("deferred tools reset details when closed", async () => {
  const { mountBasicTool } = await loadFixture()
  const tool = mountBasicTool({ defaultOpen: false, defer: true })

  expect(tool.detailsRenderCount()).toBe(0)
  expect(tool.details()).toBeNull()

  tool.trigger()?.click()
  await Promise.resolve()
  flushAnimationFrames()
  await Promise.resolve()

  expect(tool.detailsRenderCount()).toBeGreaterThan(0)
  expect(tool.details()?.textContent).toBe("details")

  tool.trigger()?.click()
  await Promise.resolve()

  expect(tool.details()).toBeNull()

  tool.dispose()
})

test("running tools stay collapsed by default but can expand existing details", async () => {
  const { mountBasicTool } = await loadFixture()
  const tool = mountBasicTool({ defaultOpen: false, defer: true, status: "running" })

  expect(tool.details()).toBeNull()

  tool.trigger()?.click()
  await Promise.resolve()
  flushAnimationFrames()
  await Promise.resolve()

  expect(tool.details()?.textContent).toBe("details")

  tool.dispose()
})

test("non-deferred default-open tools keep the previous immediate details behavior", () => {
  expect(basicToolInitialReady({ defaultOpen: true })).toBe(true)
  expect(basicToolInitialReady({ defaultOpen: true, defer: false })).toBe(true)
})

test("closed tools start without mounted details", () => {
  expect(basicToolInitialReady({ defaultOpen: false, defer: true })).toBe(false)
  expect(basicToolInitialReady({ defaultOpen: false })).toBe(false)
  expect(basicToolInitialReady({ defer: true })).toBe(false)
  expect(basicToolInitialReady({})).toBe(false)
})

test("row-local open state evicts the oldest stateKey while preserving recent keys", async () => {
  const { mountBasicTool } = await loadFixture()
  const prefix = `basic-tool-cap-${Date.now()}`

  for (let index = 0; index <= 500; index++) {
    const tool = mountBasicTool({ defaultOpen: false, stateKey: `${prefix}-${index}` })
    tool.trigger()?.click()
    await Promise.resolve()
    tool.dispose()
  }

  const oldest = mountBasicTool({ defaultOpen: false, stateKey: `${prefix}-0` })
  expect(oldest.details()).toBeNull()
  oldest.dispose()

  const recent = mountBasicTool({ defaultOpen: false, stateKey: `${prefix}-500` })
  expect(recent.details()?.textContent).toBe("details")
  recent.dispose()
})
