import { describe, expect, test } from "bun:test"
import { createBackendEnv } from "../e2e/backend"

describe("createBackendEnv", () => {
  test("does not pass inherited OpenCode server auth into isolated e2e backend", () => {
    const env = createBackendEnv({
      base: {
        PATH: "/usr/bin",
        OPENCODE_SERVER_USERNAME: "PawWork",
        OPENCODE_SERVER_PASSWORD: "secret",
        opencode_server_username: "mixed-case-user",
        opencode_server_password: "mixed-case-secret",
        CUSTOM_VALUE: "kept",
      },
      sandbox: "/tmp/pawwork-e2e",
    })

    expect(env.OPENCODE_SERVER_USERNAME).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.opencode_server_username).toBeUndefined()
    expect(env.opencode_server_password).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
    expect(env.CUSTOM_VALUE).toBe("kept")
    expect(env.OPENCODE_CLIENT).toBe("app")
  })
})
