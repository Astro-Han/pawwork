import { describe, expect, test } from "bun:test"
import { rendererWebPreferences } from "./window-options"

describe("desktop windows security", () => {
  test("renderer windows use a sandbox-compatible preload bridge without renderer Node access", () => {
    const prefs = rendererWebPreferences("/Applications/PawWork.app/Contents/Resources/app.asar/out/main")

    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    expect(prefs.preload).toEndWith("/preload/index.js")
  })
})
