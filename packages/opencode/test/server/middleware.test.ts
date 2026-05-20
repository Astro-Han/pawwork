import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { InvalidError, JsonError } from "../../src/config/error"
import { ErrorMiddleware } from "../../src/server/middleware"
import { NotFoundError } from "../../src/storage/db"

type ErrorLogCall = {
  message?: unknown
  extra?: Record<string, unknown>
}

async function captureServerErrorLogs(fn: (calls: ErrorLogCall[]) => Promise<void>) {
  const logger = Log.create({ service: "server" })
  const original = logger.error
  const calls: ErrorLogCall[] = []

  logger.error = (message, extra) => {
    calls.push({ message, extra })
  }

  try {
    await fn(calls)
  } finally {
    logger.error = original
  }

  return calls
}

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

  test("does not error-log expected not found responses", async () => {
    const app = new Hono().get("/missing", () => {
      throw new NotFoundError({ message: "Session not found: ses_missing" })
    })
    app.onError(ErrorMiddleware)

    let response!: Response
    let body!: { name: string }
    const calls = await captureServerErrorLogs(async () => {
      response = await app.request("/missing")
      body = await response.json()
    })

    expect(response.status).toBe(404)
    expect(body.name).toBe("NotFoundError")
    expect(calls).toEqual([])
  })

  test("still error-logs unexpected server failures", async () => {
    const error = new Error("boom")
    const app = new Hono().get("/boom", () => {
      throw error
    })
    app.onError(ErrorMiddleware)

    let response!: Response
    const calls = await captureServerErrorLogs(async () => {
      response = await app.request("/boom")
    })

    expect(response.status).toBe(500)
    expect(calls).toEqual([{ message: "failed", extra: { error } }])
  })
})
