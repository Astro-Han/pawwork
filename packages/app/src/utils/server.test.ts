import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, clientActionHeaders } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("clientActionHeaders", () => {
  test("creates safe renderer action headers without paths or prompt bodies", () => {
    const headers = clientActionHeaders({
      kind: "settings.provider.disconnect",
      routeSessionID: "ses_route",
      visibleSessionID: "ses_visible",
    })

    expect(headers["x-pawwork-client-action-id"]).toStartWith("client:")
    expect(headers).toMatchObject({
      "x-pawwork-client-action-kind": "settings.provider.disconnect",
      "x-pawwork-route-session-id": "ses_route",
      "x-pawwork-visible-session-id": "ses_visible",
    })
    const serialized = JSON.stringify(headers)
    expect(serialized).not.toContain("/Users/")
    expect(serialized).not.toContain("/home/")
    expect(serialized).not.toMatch(/[A-Z]:[\\/]/i)
  })
})
