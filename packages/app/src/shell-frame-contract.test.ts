import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getShellKind, getShellOs, isDesktopShell, isMacShell, isWindowsShell, shellAttrs } from "./context/platform"

function read(relativePath: string) {
  return fs.readFileSync(path.join(import.meta.dir, relativePath), "utf8").replaceAll("\r\n", "\n")
}

function hash(relativePath: string) {
  return createHash("sha256").update(fs.readFileSync(path.join(import.meta.dir, relativePath))).digest("hex")
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

test("desktop shell shares titlebar height across titlebar and narrow sidebar geometry", () => {
  const css = read("./index.css")
  const layout = read("./pages/layout.tsx")
  const titlebar = read("./components/titlebar.tsx")
  const sessionHeader = read("./components/session/session-header.tsx")
  const pawworkTitlebar = read("./pages/layout/pawwork-titlebar.tsx")
  const wideDesktopQuery = css.indexOf("@media (min-width: 1280px)")
  const macMainSeamRule = css.indexOf(
    '[data-component="desktop-shell-main"][data-shell="desktop"][data-shell-os="macos"] {',
  )
  const wideFrameRule = css.indexOf(
    '[data-component="desktop-shell-frame"][data-shell="desktop"][data-shell-os="linux"] {',
  )

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
  expect(layout).toContain("{...shellAttrs(platform)}")
  expect(layout).toContain("isMacShell(platform)")
  expect(layout).not.toContain("top-10")
  expect(titlebar).toContain('"h-11": isDesktopShell(platform) && !mac()')
  expect(titlebar).toContain("{...shellAttrs(platform)}")
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

  expect(entry).toMatch(/const\s+platform:\s*Platform\s*=\s*\{[\s\S]*?platform:\s*"web"/)
  expect(entry).toMatch(/const\s+platform:\s*Platform\s*=\s*\{[\s\S]*?shell:\s*\{[\s\S]*?kind:\s*"desktop"/)
  expect(entry).toMatch(/const\s+platform:\s*Platform\s*=\s*\{[\s\S]*?shell:\s*\{[\s\S]*?os:\s*detectShellOs\(\)/)
  expect(entry).toContain("const detectShellOs")
  expect(entry).toMatch(/envOverride[\s\S]*runtimeDetectedOs[\s\S]*"macos"/)
  expect(platform).toContain('shell?: PlatformShell')
  expect(platform).toContain("export function getShellKind")
  expect(platform).toContain("export function getShellOs")
  expect(platform).toContain("export function shellAttrs")
  expect(platform).toContain("export function isDesktopShell")
  expect(platform).toContain("export function isMacShell")
  expect(platform).toContain("export function isWindowsShell")
})

test("shell helpers keep runtime identity separate from visual shell identity", () => {
  const webDesktop = { platform: "web" as const, shell: { kind: "desktop" as const, os: "macos" as const } }

  expect(getShellKind(webDesktop)).toBe("desktop")
  expect(getShellOs(webDesktop)).toBe("macos")
  expect(isDesktopShell(webDesktop)).toBe(true)
  expect(isMacShell(webDesktop)).toBe(true)
  expect(isWindowsShell(webDesktop)).toBe(false)
  expect(shellAttrs(webDesktop)).toEqual({ "data-shell": "desktop", "data-shell-os": "macos" })
  expect(isDesktopShell({ platform: "web" })).toBe(false)
  expect(isDesktopShell({ platform: "desktop" })).toBe(true)
})

test("visual shell files do not key appearance from runtime platform identity", () => {
  const visualSources = [
    "./components/titlebar.tsx",
    "./pages/layout.tsx",
    "./components/session/session-header.tsx",
    "./components/settings-general.tsx",
  ]

  for (const file of visualSources) {
    expect(stripComments(read(file)), file).not.toMatch(/platform\.platform\s*={2,3}\s*["']desktop["']/)
  }

  const css = read("./index.css")
  expect(css).not.toContain('[data-platform="desktop"]')
  expect(css).not.toContain("[data-platform='desktop']")
})

test("web favicon uses PawWork branding instead of the inherited OpenCode mark", () => {
  const html = read("../index.html")
  const favicon = read("../../ui/src/assets/favicon/favicon-v3.svg")

  expect(html).toContain("/favicon-96x96-v3.png")
  expect(html).toContain("/favicon-v3.svg")
  expect(html).toContain("/favicon-v3.ico")
  expect(favicon).toMatch(/#ff6b2b/i)
  expect(favicon).toMatch(/#fff8f0/i)
  expect(favicon).not.toMatch(/#131010/i)
  expect(hash("../../ui/src/assets/favicon/favicon-96x96-v3.png")).not.toBe(
    "aa34092540de60c889610edfa3c25316e215f12d88af29cfba530d09aee7265c",
  )
  expect(hash("../../ui/src/assets/favicon/favicon-v3.ico")).not.toBe(
    "808e1ca7659cb52e0240aac075ccecdf5539047da02150f2b95e0aa78a44056f",
  )
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
