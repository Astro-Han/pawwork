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
  const pawworkTitlebar = read("./pages/layout/pawwork-titlebar.tsx")
  const wideDesktopQuery = css.indexOf("@media (min-width: 1280px)")
  const macMainSeamRule = css.indexOf('[data-component="desktop-shell-main"][data-shell="desktop"][data-os="macos"] {')
  const wideFrameRule = css.indexOf('[data-component="desktop-shell-frame"][data-shell="desktop"][data-os="linux"] {')

  expect(css).toContain('[data-component="desktop-shell"][data-shell="desktop"] {')
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
  expect(layout).toContain("isMacShell(platform)")
  expect(layout).not.toContain("top-10")
  expect(titlebar).toContain('"h-11": isDesktopShell(platform) && !mac()')
  expect(titlebar).toContain('style={{ height: currentTitlebarHeight(), "min-height": currentTitlebarHeight() }}')
  expect(titlebar).toContain("--sidebar-width")
  expect(titlebar).toContain("--right-panel-width")
  expect(titlebar).toMatch(/id=["']pawwork-titlebar-left["']/)
  expect(titlebar).toMatch(/id=["']pawwork-titlebar-center["']/)
  expect(titlebar).toMatch(/id=["']pawwork-titlebar-right["']/)
  expect(sessionHeader).toMatch(/document\.getElementById\(["']pawwork-titlebar-left["']\)/)
  expect(sessionHeader).toMatch(/document\.getElementById\(["']pawwork-titlebar-right["']\)/)
  expect(pawworkTitlebar).toMatch(/document\.getElementById\(["']pawwork-titlebar-center["']\)/)
})

test("web runtime uses the desktop shell without claiming Electron platform identity", () => {
  const entry = read("./entry.tsx")
  const platform = read("./context/platform.tsx")

  expect(entry).toContain('platform: "web"')
  expect(entry).toContain('shell: { kind: "desktop"')
  expect(entry).toContain("getShellOs")
  expect(platform).toContain('shell?: PlatformShell')
  expect(platform).toContain("export function isDesktopShell")
  expect(platform).toContain("export function isMacShell")
  expect(platform).toContain("export function isWindowsShell")
})

test("session composer is docked outside the scroll-clipped timeline region", () => {
  const session = read("./pages/session.tsx")
  const sessionMainView = read("./pages/session/session-main-view.tsx")
  const messageTimeline = read("./pages/session/message-timeline.tsx")

  expect(session).toContain("const renderComposerRegion = (")
  expect(session).toContain('variant: "session" | "home"')
  expect(sessionMainView).toContain('<div class="flex-1 min-h-0 overflow-hidden">')
  expect(sessionMainView).toContain(
    "</div>\n          <Show when={props.activeSessionID}>{props.composerSession}</Show>",
  )
  expect(messageTimeline).toContain('"padding-bottom": "calc(var(--composer-dock-height, 0px) + 32px)"')
})

test("session header uses a view title on home and breadcrumb title in sessions", () => {
  const sessionHeader = read("./components/session/session-header.tsx")

  expect(sessionHeader).toContain('language.t("command.session.new")')
  expect(sessionHeader).toContain("sync.session.get(params.id)")
  expect(sessionHeader).not.toContain('language.t("session.header.searchFiles")')
  expect(sessionHeader).not.toContain('language.t("session.header.search.placeholder"')
})

test("titlebar drops Windows-only 138px placeholder and conditional drag region", () => {
  const titlebar = read("./components/titlebar.tsx")
  expect(titlebar).not.toContain('class="w-36 shrink-0"')
  expect(titlebar).toContain("data-shell-drag-region={!windows() || undefined}")
})
