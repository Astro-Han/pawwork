import { describe, expect, test } from "bun:test"
import path from "node:path"
import { rendererWebPreferences } from "./window-options"

describe("desktop windows security", () => {
  test("renderer windows use a sandbox-compatible preload bridge without renderer Node access", () => {
    const prefs = rendererWebPreferences("/Applications/PawWork.app/Contents/Resources/app.asar/out/main")

    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    // `path.join` uses backslashes on Windows, so compare with the platform
    // separator instead of hardcoding `/preload/index.js`.
    expect(prefs.preload).toEndWith(path.join("preload", "index.js"))
  })
})
