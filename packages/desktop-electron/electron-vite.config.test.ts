import { expect, test } from "bun:test"
import desktopBuild from "./electron.vite.config"

test("production build has a single DSH desktop entry", () => {
  expect(desktopBuild.main).toBeDefined()
  expect(desktopBuild.preload).toBeUndefined()
  expect(desktopBuild.renderer).toBeUndefined()
})
