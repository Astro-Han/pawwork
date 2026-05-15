import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { Log } from "@opencode-ai/core/util/log"
import { assertPtyConnectTarget, PtyRoutes } from "../../src/server/instance/pty"
import { ErrorMiddleware } from "../../src/server/middleware"
import { NotFoundError } from "../../src/storage/db"
import { PtyID } from "../../src/pty/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const testUpgradeWebSocket = ((createEvents: (c: unknown) => unknown | Promise<unknown>) => {
  return async (c: { text: (value: string) => Response | Promise<Response> }) => {
    await createEvents(c)
    return c.text("upgraded")
  }
}) as unknown as UpgradeWebSocket

describe("pty routes", () => {
  test("reports missing websocket connect targets as not found", () => {
    expect(() => assertPtyConnectTarget(undefined)).toThrow(NotFoundError)
  })

  test("accepts existing websocket connect targets", () => {
    expect(() => assertPtyConnectTarget({ id: "pty_present" })).not.toThrow()
  })

  test("maps missing websocket connect targets through the route as not found", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
        app.onError(ErrorMiddleware)

        const response = await app.request(`/pty/${PtyID.ascending()}/connect`)
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.name).toBe("NotFoundError")
      },
    })
  })
})
