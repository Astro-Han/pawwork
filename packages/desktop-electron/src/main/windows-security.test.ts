import { describe, expect, test } from "bun:test"
import { dshWebPreferences } from "./window-options"

describe("desktop windows security", () => {
  test("DSH windows do not receive a privileged desktop bridge", () => {
    const prefs = dshWebPreferences()

    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    })
    expect(prefs).not.toHaveProperty("preload")
  })
})
