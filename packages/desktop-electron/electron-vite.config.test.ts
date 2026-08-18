import { expect, test } from "bun:test"
import desktopBuild from "./electron.vite.config"

test("production build has a single DSH desktop entry", () => {
  expect(desktopBuild.main).toBeDefined()
  expect(desktopBuild.preload).toBeUndefined()
  expect(desktopBuild.renderer).toBeUndefined()

  const pluginNames = desktopBuild.main?.plugins?.map((plugin) => plugin && "name" in plugin ? plugin.name : undefined) ?? []
  expect(pluginNames).not.toContain("opencode:virtual-server-module")
  expect(pluginNames).not.toContain("opencode:copy-server-assets")
  expect(pluginNames).not.toContain("opencode:copy-opencli-runtime")
})
