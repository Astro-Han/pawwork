import { describe, expect, test } from "bun:test"
import { BROWSER_PARTITION, browserViewWebPreferences } from "./options"

describe("embedded browser security", () => {
  test("uses a locked-down, preload-free, sandboxed view on a persistent partition", () => {
    const prefs = browserViewWebPreferences()

    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    // The embedded page must never receive the app's IPC preload bridge.
    expect(prefs.preload).toBeUndefined()
    expect(prefs.partition).toBe(BROWSER_PARTITION)
    expect(BROWSER_PARTITION.startsWith("persist:")).toBe(true)
  })
})
