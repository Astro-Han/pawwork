import { expect, test } from "vitest"
import { TITLEBAR_HEIGHT, macTrafficLightPosition, pawworkWindowTitle, titlebarInsetCss } from "./window-chrome"
import { dshTitleBarOptions } from "./window-options"

test("macOS traffic lights use the DSH shell position", () => {
  expect(macTrafficLightPosition()).toEqual({
    x: 12,
    y: 10,
  })
})

// macOS is the only platform whose titlebar height we publish ourselves: Windows
// reads Chromium's env(titlebar-area-*) and Linux keeps its system title bar.
test.each([
  ["darwin", false, `:root { --pawwork-titlebar-host-height: ${TITLEBAR_HEIGHT}px; }`],
  ["darwin", true, ""],
  ["win32", false, ""],
  ["linux", false, ""],
] as const)("publishes the titlebar inset for %s (fullscreen=%s)", (platform, fullscreen, expected) => {
  expect(titlebarInsetCss(platform, { fullscreen })).toBe(expected)
})

// A frameless window has to reserve the band; a framed one must not. Losing
// either half leaves the sidebar under the native controls or a dead strip.
test.each(["darwin", "win32", "linux"] as const)("%s reserves a titlebar band exactly when it is frameless", (platform) => {
  const frameless = "titleBarStyle" in dshTitleBarOptions(platform)
  const reserved = platform === "win32" || titlebarInsetCss(platform, { fullscreen: false }) !== ""
  expect(reserved).toBe(frameless)
})

test.each([
  ["DeepSeek Harness", "PawWork"],
  ["Quarterly plan — DeepSeek Harness", "Quarterly plan — PawWork"],
  ["Quarterly plan", "Quarterly plan"],
])("maps the DSH page title %s to the PawWork window title", (pageTitle, expected) => {
  expect(pawworkWindowTitle(pageTitle)).toBe(expected)
})
