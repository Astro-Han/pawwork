import { expect, test } from "vitest"
import { quitWhenAllWindowsClosed, sidebarMode } from "./launch-mode"

test("packaged Windows launches the persistent sidebar from the Start menu", () => {
  expect(sidebarMode("win32", true, undefined, ["PawWork Dev.exe"])).toBe(true)
})

test("development keeps the existing explicit sidebar switch", () => {
  expect(sidebarMode("win32", false, undefined, ["electron"])).toBe(false)
  expect(sidebarMode("win32", false, "true", ["electron"])).toBe(true)
  expect(sidebarMode("win32", false, undefined, ["electron", "--sidebar"])).toBe(true)
})

test("the standard window remains available by explicit opt out", () => {
  expect(sidebarMode("win32", true, "false", ["PawWork Dev.exe"])).toBe(false)
  expect(sidebarMode("darwin", true, undefined, ["PawWork"])).toBe(false)
})

test("closing the last sidebar window keeps the shortcut process alive", () => {
  expect(quitWhenAllWindowsClosed("win32", true)).toBe(false)
  expect(quitWhenAllWindowsClosed("win32", false)).toBe(true)
  expect(quitWhenAllWindowsClosed("darwin", false)).toBe(false)
})
