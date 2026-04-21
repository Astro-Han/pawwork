import { describe, expect, test } from "bun:test"
import { buildDesktopContext } from "./desktop-context"

describe("desktop context", () => {
  test("builds route-only context without stale session", () => {
    expect(
      buildDesktopContext({
        route: "/abc",
        locale: "zh",
      }),
    ).toEqual({
      directory: null,
      sessionID: null,
      route: "/abc",
      locale: "zh",
    })
  })

  test("builds active session context", () => {
    expect(
      buildDesktopContext({
        directory: "/tmp/project",
        sessionID: "ses_123",
        route: "/abc/session/ses_123",
        locale: "en",
      }),
    ).toEqual({
      directory: "/tmp/project",
      sessionID: "ses_123",
      route: "/abc/session/ses_123",
      locale: "en",
    })
  })
})
