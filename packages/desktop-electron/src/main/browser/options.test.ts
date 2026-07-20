import { describe, expect, test } from "bun:test"
import { browserViewWebPreferences } from "./options"

describe("embedded browser security", () => {
  test("uses a locked-down persistent partition isolated by browser profile", () => {
    const first = browserViewWebPreferences("profile-a")
    const second = browserViewWebPreferences("profile-b")

    expect(first).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    // The embedded page must never receive the app's IPC preload bridge.
    expect(first.preload).toBeUndefined()
    expect(first.partition).not.toBe(second.partition)
    expect(first.partition?.startsWith("persist:")).toBe(true)
  })
})
