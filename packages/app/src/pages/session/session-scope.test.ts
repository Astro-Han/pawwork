import { describe, expect, test } from "bun:test"
import { makeSessionScope, sameSessionScope, sessionScopeKey } from "./session-scope"

describe("session scope", () => {
  test("keys include server and session", () => {
    expect(sessionScopeKey({ serverKey: "sidecar", sessionID: "ses_same" })).not.toBe(
      sessionScopeKey({ serverKey: "https://remote.example", sessionID: "ses_same" }),
    )
  })

  test("constructs only when both fields exist", () => {
    expect(makeSessionScope({ serverKey: "sidecar", sessionID: "ses_1" })).toEqual({
      serverKey: "sidecar",
      sessionID: "ses_1",
    })
    expect(makeSessionScope({ serverKey: undefined, sessionID: "ses_1" })).toBeUndefined()
    expect(makeSessionScope({ serverKey: "sidecar", sessionID: undefined })).toBeUndefined()
  })

  test("compares server and session", () => {
    expect(
      sameSessionScope(
        { serverKey: "sidecar", sessionID: "ses_1" },
        { serverKey: "sidecar", sessionID: "ses_1" },
      ),
    ).toBe(true)
    expect(
      sameSessionScope(
        { serverKey: "sidecar", sessionID: "ses_1" },
        { serverKey: "remote", sessionID: "ses_1" },
      ),
    ).toBe(false)
  })
})
