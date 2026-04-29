import { describe, expect, test } from "bun:test"
import { withoutInternalServerAuthEnv } from "../../src/util/env"

describe("util.env", () => {
  test("does not mutate caller-owned env objects", () => {
    const env: Record<string, string> = {
      OPENCODE_SERVER_USERNAME: "PawWork",
      OPENCODE_SERVER_PASSWORD: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    }

    const sanitized = withoutInternalServerAuthEnv(env)

    expect(sanitized).toEqual({ PAWWORK_E2E_CUSTOM_ENV: "kept" })
    expect(env).toEqual({
      OPENCODE_SERVER_USERNAME: "PawWork",
      OPENCODE_SERVER_PASSWORD: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    })
    expect(sanitized).not.toBe(env)
  })

  test("removes internal auth keys regardless of case", () => {
    const env: Record<string, string> = {
      OpEnCoDe_Server_UserName: "PawWork",
      opencode_server_password: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    }

    const sanitized = withoutInternalServerAuthEnv(env)

    expect(sanitized).toEqual({ PAWWORK_E2E_CUSTOM_ENV: "kept" })
    expect(env).toEqual({
      OpEnCoDe_Server_UserName: "PawWork",
      opencode_server_password: "secret",
      PAWWORK_E2E_CUSTOM_ENV: "kept",
    })
    expect(sanitized).not.toBe(env)
  })
})
