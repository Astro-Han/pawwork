import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createRequire } from "module"
import { createServer, type ViteDevServer } from "vite"
import solidPlugin from "vite-plugin-solid"

// Real render of the notice part (#1358): the side-effect/default copy must be
// driven by the backend `sideEffect` field alone. The notice carries no tool
// part and no DataProvider, so a correct copy proves the UI never needs to scan
// or classify tools — replacing the earlier brittle source-string assertions.

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
    root: new URL("../../../..", import.meta.url).pathname,
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

async function loadFixture(): Promise<typeof import("../../../../test/fixtures/notice-render.fixture")> {
  if (!server) throw new Error("Vite server not initialized")
  return (await server.ssrLoadModule(
    "/test/fixtures/notice-render.fixture.tsx",
  )) as typeof import("../../../../test/fixtures/notice-render.fixture")
}

test("sideEffect=true renders the reassuring 'action completed' copy, with no tool in sight", async () => {
  const { mountNotice } = await loadFixture()
  const view = mountNotice(true)

  expect(view.variant()).toBe("side-effect")
  expect(view.title()).toBe("Action completed")
  expect(view.body()).toContain("no need to repeat it")
  // The copy was chosen from the field, not from any rendered/scanned tool.
  expect(view.toolCard()).toBeNull()

  view.dispose()
})

test("sideEffect=false falls back to the default 'reply incomplete' copy", async () => {
  const { mountNotice } = await loadFixture()
  const view = mountNotice(false)

  expect(view.variant()).toBe("default")
  expect(view.title()).toBe("Reply incomplete")
  expect(view.body()).toContain("couldn't be generated")

  view.dispose()
})

test("a missing sideEffect field (older notices) is treated as the safe default", async () => {
  const { mountNotice } = await loadFixture()
  const view = mountNotice(undefined)

  expect(view.variant()).toBe("default")
  expect(view.title()).toBe("Reply incomplete")

  view.dispose()
})

test("the same field drives localized copy (zh)", async () => {
  const { mountNotice, dicts } = await loadFixture()

  const side = mountNotice(true, dicts.zh)
  expect(side.variant()).toBe("side-effect")
  expect(side.title()).toBe("操作已完成")
  expect(side.body()).toContain("无需重复")
  side.dispose()

  const plain = mountNotice(false, dicts.zh)
  expect(plain.variant()).toBe("default")
  expect(plain.title()).toBe("回复未完成")
  plain.dispose()
})
