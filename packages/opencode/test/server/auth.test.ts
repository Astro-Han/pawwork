import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"
import { AuthMiddleware } from "../../src/server/middleware"
import { Hono } from "hono"

const mutableFlag = Flag as {
  OPENCODE_SERVER_PASSWORD?: string
  OPENCODE_SERVER_USERNAME?: string
}

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  mutableFlag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  mutableFlag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = undefined
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults to the opencode username", () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })
})

describe("AuthMiddleware", () => {
  const app = () => {
    const app = new Hono()
    app.use(AuthMiddleware)
    app.get("/", (c) => c.text("ok"))
    return app
  }

  test("authorizes auth_token query credentials without requiring a mutable request header", async () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    const token = Buffer.from("alice:secret").toString("base64")
    const response = await app().request(`/?auth_token=${encodeURIComponent(token)}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  test("accepts case-insensitive Basic auth with flexible spacing", async () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    const response = await app().request("/", {
      headers: {
        authorization: `basic   ${Buffer.from("alice:secret").toString("base64")}`,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
  })

  test("returns a Basic challenge when credentials are missing", async () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    const response = await app().request("/")

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="opencode"')
  })

  test("returns a Basic challenge when credentials are invalid", async () => {
    mutableFlag.OPENCODE_SERVER_PASSWORD = "secret"
    mutableFlag.OPENCODE_SERVER_USERNAME = "alice"

    const response = await app().request("/", {
      headers: {
        authorization: `Basic ${Buffer.from("alice:wrong").toString("base64")}`,
      },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="opencode"')
  })
})
