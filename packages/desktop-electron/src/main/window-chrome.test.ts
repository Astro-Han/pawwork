import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import {
  LEGACY_MACOS_TITLEBAR_HEIGHT,
  LEGACY_MACOS_TRAFFIC_LIGHT_Y,
  MACOS_SHELL_TITLEBAR_HEIGHT,
  WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
  macTrafficLightPosition,
} from "./window-chrome"

function appIndexCss() {
  return fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", "app", "src", "index.css"), "utf8")
}

test("macOS traffic lights stay centered when shell titlebar height increases", () => {
  const css = appIndexCss()
  const wideDesktopQuery = css.indexOf("@media (min-width: 1280px)")
  const macTitlebarBlock = css.indexOf('[data-component="titlebar-shell"][data-platform="desktop"][data-os="macos"] {')

  expect(wideDesktopQuery).toBeGreaterThan(-1)
  expect(css).toContain('[data-component="desktop-shell"][data-platform="desktop"] {')
  expect(css).toContain("--shell-titlebar-height: 40px;")
  expect(css).toContain('[data-component="desktop-shell"][data-platform="desktop"][data-os="macos"] {')
  expect(macTitlebarBlock).toBeGreaterThan(-1)
  expect(macTitlebarBlock).toBeLessThan(wideDesktopQuery)
  expect(css).toContain("--shell-titlebar-height: 48px;")
  expect(WINDOWS_TITLEBAR_OVERLAY_HEIGHT).toBe(40)
  expect(macTrafficLightPosition()).toEqual({
    x: 12,
    y: LEGACY_MACOS_TRAFFIC_LIGHT_Y + (MACOS_SHELL_TITLEBAR_HEIGHT - LEGACY_MACOS_TITLEBAR_HEIGHT) / 2,
  })
})
