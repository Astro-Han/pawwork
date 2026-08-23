import { expect, test } from "vitest"
import { TITLEBAR_HEIGHT, macTrafficLightPosition, pawworkWindowTitle, titlebarInsetCss } from "./window-chrome"

test("macOS traffic lights align with the sidebar header after the full-width inset is removed", () => {
  expect(macTrafficLightPosition()).toEqual({
    x: 12,
    y: 30,
  })
})

// macOS is the only platform whose titlebar height we publish ourselves: Windows
// reads Chromium's env(titlebar-area-*) and Linux keeps its system title bar.
test.each([
  ["darwin", false, `:root { --pawwork-titlebar-host-height: ${TITLEBAR_HEIGHT}px; --pawwork-titlebar-host-inset-left: 72px; }`],
  ["darwin", true, ""],
  ["win32", false, ""],
  ["linux", false, ""],
] as const)("publishes the titlebar inset for %s (fullscreen=%s)", (platform, fullscreen, expected) => {
  expect(titlebarInsetCss(platform, { fullscreen })).toBe(expected)
})

// The band-exists-exactly-when-frameless relationship is asserted where it can
// actually be observed: scripts/ci-smoke.ts measures the rendered strip against
// dshTitleBarOptions on both platforms in CI. Restating it here could only be a
// tautology, since both sides would come from the same two pure functions.

test.each([
  ["DeepSeek Harness", "PawWork"],
  ["Quarterly plan — DeepSeek Harness", "Quarterly plan — PawWork"],
  ["Quarterly plan", "Quarterly plan"],
])("maps the DSH page title %s to the PawWork window title", (pageTitle, expected) => {
  expect(pawworkWindowTitle(pageTitle)).toBe(expected)
})
