import { describe, expect, test } from "bun:test"
import { dshWebPreferences } from "./window-options"

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
})
