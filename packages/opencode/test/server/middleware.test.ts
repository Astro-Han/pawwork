import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { InvalidError, JsonError } from "../../src/config/error"
import { ErrorMiddleware } from "../../src/server/middleware"

describe("server error middleware", () => {
  test("serializes config named errors instead of wrapping them as unknown errors", async () => {
    const app = new Hono().get("/boom", () => {
      throw new JsonError({ path: "opencode.json", message: "bad json" })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.name).toBe("ConfigJsonError")
    expect(body.data.path).toBe("opencode.json")
    expect(body.data.message).toBe("bad json")
  })

  test("serializes config invalid errors with issues", async () => {
    const app = new Hono().get("/boom", () => {
      throw new InvalidError({
        path: "opencode.json",
        issues: [{ code: "custom", message: "bad field", path: ["server", "hostname"] }],
      })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.name).toBe("ConfigInvalidError")
    expect(body.data.path).toBe("opencode.json")
    expect(body.data.issues).toEqual([{ code: "custom", message: "bad field", path: ["server", "hostname"] }])
  })

  test("serializes config invalid errors without issues", async () => {
    const app = new Hono().get("/boom", () => {
      throw new InvalidError({
        path: "opencode.json",
        message: "bad config",
      })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.name).toBe("ConfigInvalidError")
    expect(body.data.path).toBe("opencode.json")
    expect(body.data.message).toBe("bad config")
    expect(body.data.issues).toBeUndefined()
  })
})
