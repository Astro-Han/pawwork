import { describe, expect, test } from "vitest"
import { dshTitleBarOptions, dshWebPreferences } from "./window-options"

describe("desktop windows security", () => {
  test("DSH windows receive only the scoped PawWork file picker bridge", () => {
    const prefs = dshWebPreferences("/resources/dsh/product/preload.cjs")

    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: "/resources/dsh/product/preload.cjs",
    })
  })

  test("Windows uses system caption buttons over the frameless DSH shell", () => {
    expect(dshTitleBarOptions("win32", "light")).toEqual({
      titleBarOverlay: { color: "transparent", height: 32, symbolColor: "#1f2328" },
      titleBarStyle: "hidden",
    })
    expect(dshTitleBarOptions("darwin")).toEqual({ titleBarStyle: "hidden" })
  })

  test("Windows caption symbols follow the resolved dark theme", () => {
    expect(dshTitleBarOptions("win32", "dark")).toEqual({
      titleBarOverlay: { color: "transparent", height: 32, symbolColor: "#f0f0f0" },
      titleBarStyle: "hidden",
    })
  })
})
