import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import {
  LEGACY_MACOS_TITLEBAR_HEIGHT,
  LEGACY_MACOS_TRAFFIC_LIGHT_Y,
  MACOS_SHELL_TITLEBAR_HEIGHT,
  macTrafficLightPosition,
} from "./window-chrome"

function appIndexCss() {
  return fs.readFileSync(path.join(import.meta.dir, "..", "..", "..", "app", "src", "index.css"), "utf8")
}

test("macOS traffic lights stay centered when shell titlebar height increases", () => {
  const css = appIndexCss()
  const wideDesktopQuery = css.indexOf("@media (min-width: 1280px)")

  expect(wideDesktopQuery).toBeGreaterThan(-1)
  expect(css).toContain('[data-component="desktop-shell"][data-platform="desktop"] {')
  expect(css).toContain("--shell-titlebar-height: 44px;")
  expect(css).not.toContain("--shell-titlebar-height: 40px;")
  expect(css).not.toContain("--shell-titlebar-height: 48px;")
  expect(macTrafficLightPosition()).toEqual({
    x: 12,
    y: 16,
  })
})
