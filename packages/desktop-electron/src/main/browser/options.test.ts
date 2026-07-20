import { describe, expect, test } from "bun:test"
import type { Session } from "electron"
import { browserViewWebPreferences } from "./options"

describe("embedded browser security", () => {
  test("uses the supplied profile session with locked-down web preferences", () => {
    const profileSession = {} as Session
    const preferences = browserViewWebPreferences(profileSession)

    expect(preferences).toMatchObject({
      session: profileSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    })
    // The embedded page must never receive the app's IPC preload bridge.
    expect(preferences.preload).toBeUndefined()
    expect(preferences.partition).toBeUndefined()
  })
})
