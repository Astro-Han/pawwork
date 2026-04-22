import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

function read(relativePath: string) {
  return fs.readFileSync(path.join(import.meta.dir, relativePath), "utf8").replaceAll("\r\n", "\n")
}

test("desktop shell shares titlebar height across titlebar and narrow sidebar geometry", () => {
  const css = read("./index.css")
  const layout = read("./pages/layout.tsx")
  const titlebar = read("./components/titlebar.tsx")
  const sessionHeader = read("./components/session/session-header.tsx")
  const wideDesktopQuery = css.indexOf("@media (min-width: 1280px)")
  const macMainSeamRule = css.indexOf('[data-component="desktop-shell-main"][data-platform="desktop"][data-os="macos"] {')
  const wideFrameRule = css.indexOf('[data-component="desktop-shell-frame"][data-platform="desktop"]:not([data-os="macos"]) {')

  expect(css).toContain('[data-component="desktop-shell"][data-platform="desktop"] {')
  expect(css).toContain("--shell-titlebar-height: 44px;")
  expect(css).not.toContain("--shell-titlebar-height: 40px;")
  expect(css).not.toContain("--shell-titlebar-height: 48px;")
  expect(css).toContain(':root[data-color-scheme="dark"] {')
  expect(css).not.toContain("@media (prefers-color-scheme: dark)")
  expect(wideDesktopQuery).toBeGreaterThan(-1)
  expect(wideFrameRule).toBeGreaterThan(wideDesktopQuery)
  expect(macMainSeamRule).toBeGreaterThan(-1)
  expect(macMainSeamRule).toBeLessThan(wideDesktopQuery)
  expect(layout).toContain('"--shell-titlebar-current-height"')
  expect(layout).toContain('platform.os === "macos"')
  expect(layout).toContain('top: "var(--shell-titlebar-current-height, var(--shell-titlebar-height, 2.75rem))"')
  expect(layout).not.toContain("top-10")
  expect(titlebar).toContain('"h-11": platform.platform === "desktop" && !mac()')
  expect(titlebar).toContain('style={{ height: currentTitlebarHeight(), "min-height": currentTitlebarHeight() }}')
  expect(sessionHeader).toContain('document.getElementById("opencode-titlebar-center")')
  expect(sessionHeader).toContain('document.getElementById("opencode-titlebar-right")')
})

test("session composer is docked outside the scroll-clipped timeline region", () => {
  const session = read("./pages/session.tsx")

  expect(session).toContain('const renderComposerRegion = (variant: "session" | "home") => (')
  expect(session).toContain('<div class="flex-1 min-h-0 overflow-hidden">')
  expect(session).toContain('</div>\n          <Show when={params.id}>{renderComposerRegion("session")}</Show>')
})

test("session header uses a view title on home and breadcrumb title in sessions", () => {
  const sessionHeader = read("./components/session/session-header.tsx")

  expect(sessionHeader).toContain('language.t("command.session.new")')
  expect(sessionHeader).toContain('sync.session.get(params.id)')
  expect(sessionHeader).not.toContain('language.t("session.header.searchFiles")')
  expect(sessionHeader).not.toContain('language.t("session.header.search.placeholder"')
})
