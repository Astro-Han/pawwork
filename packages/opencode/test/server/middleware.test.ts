import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { InvalidError, JsonError } from "../../src/config/error"
import { ErrorMiddleware } from "../../src/server/middleware"
import { NotFoundError } from "../../src/storage/db"

async function readLogFile() {
  for (let i = 0; i < 20; i++) {
    const text = await readFile(Log.file(), "utf8").catch(() => "")
    if (text.length > 0) return text
    await Bun.sleep(10)
  }
  return readFile(Log.file(), "utf8").catch(() => "")
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
    await Log.init({ print: false })
    const app = new Hono().get("/missing", () => {
      throw new NotFoundError({ message: "Session not found: ses_missing" })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/missing")
    const body = await response.json()
    const logs = await readLogFile()

    expect(response.status).toBe(404)
    expect(body.name).toBe("NotFoundError")
    expect(logs).not.toContain("ERROR")
    expect(logs).not.toContain("failed")
  })

  test("still error-logs unexpected server failures", async () => {
    await Log.init({ print: false })
    const app = new Hono().get("/boom", () => {
      throw new Error("boom")
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const logs = await readLogFile()

    expect(response.status).toBe(500)
    expect(logs).toContain("ERROR")
    expect(logs).toContain("failed")
    expect(logs).toContain("boom")
  })
})
