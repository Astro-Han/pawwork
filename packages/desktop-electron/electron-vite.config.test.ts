import { afterEach, expect, test, vi } from "vitest"
import desktopBuild from "./electron.vite.config"

test("production build has a single DSH desktop entry", () => {
  expect(desktopBuild.main).toBeDefined()
  expect(desktopBuild.preload).toBeUndefined()
  expect(desktopBuild.renderer).toBeUndefined()
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

// This define is the only thing that decides what CHANNEL the bundled main
// process sees, and it is read from the environment at config load. A channel it
// fails to recognise ships as dev: dev appId, dev profile directory, updater
// off — while electron-builder, which parses the same variable elsewhere, still
// names and signs the build for the channel that was asked for.
test.each([
  ["prod", "prod"],
  ["dev", "dev"],
  ["nightly", "dev"],
  [undefined, "dev"],
])("compiles OPENCODE_CHANNEL=%s into the main process as %s", async (raw, expected) => {
  vi.resetModules()
  vi.stubEnv("OPENCODE_CHANNEL", raw)

  const config = (await import("./electron.vite.config")).default

  expect(config.main?.define).toEqual({ "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(expected) })
})
