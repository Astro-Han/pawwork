import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

function read(relativePath: string) {
  return fs.readFileSync(path.join(import.meta.dir, relativePath), "utf8")
}

test("desktop shell shares titlebar height across titlebar and narrow sidebar geometry", () => {
  const css = read("./index.css")
  const layout = read("./pages/layout.tsx")
  const titlebar = read("./components/titlebar.tsx")
  const sessionHeader = read("./components/session/session-header.tsx")
  const wideDesktopQuery = css.indexOf("@media (min-width: 1280px)")
  const macMainSeamRule = css.indexOf('[data-component="desktop-shell-main"][data-platform="desktop"][data-os="macos"] {')

  expect(css).toContain('[data-component="desktop-shell"][data-platform="desktop"] {')
  expect(css).toContain("--shell-titlebar-height: 40px;")
  expect(css).toContain('[data-component="desktop-shell"][data-platform="desktop"][data-os="macos"] {')
  expect(css).toContain("--shell-titlebar-height: 48px;")
  expect(wideDesktopQuery).toBeGreaterThan(-1)
  expect(macMainSeamRule).toBeGreaterThan(-1)
  expect(macMainSeamRule).toBeLessThan(wideDesktopQuery)
  expect(layout).toContain('"--shell-titlebar-current-height"')
  expect(layout).toContain('platform.os === "macos"')
  expect(layout).toContain('top: "var(--shell-titlebar-current-height, var(--shell-titlebar-height, 2.5rem))"')
  expect(layout).not.toContain("top-10")
  expect(titlebar).toContain('style={{ height: currentTitlebarHeight(), "min-height": currentTitlebarHeight() }}')
  expect(sessionHeader).toContain('document.getElementById("opencode-titlebar-center")')
  expect(sessionHeader).toContain('document.getElementById("opencode-titlebar-right")')
})
