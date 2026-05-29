import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { Log } from "@opencode-ai/core/util/log"
import { assertPtyConnectTarget, PtyRoutes } from "../../src/server/instance/pty"
import { ErrorMiddleware } from "../../src/server/middleware"
import { NotFoundError } from "../../src/storage/db"
import { Pty } from "../../src/pty"
import { PtyID } from "../../src/pty/schema"
import { PtyTicket } from "../../src/pty/ticket"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
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

  test("issues a connect token for an existing PTY", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Pty.create({
          command: "/bin/sh",
          args: ["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
          title: "ticket",
        })
        try {
          const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
          app.onError(ErrorMiddleware)

          const response = await app.request(`/pty/${info.id}/connect-token`, { method: "POST" })
          const body = await response.json()

          expect(response.status).toBe(200)
          expect(body.ticket).toBeString()
          expect(body.expires_in).toBe(60)
          expect(PtyTicket.consume({ ptyID: info.id, ticket: body.ticket })).toBe(true)
        } finally {
          await Pty.remove(info.id)
        }
      },
    })
  })

  test("rejects invalid connect tickets before checking PTY existence", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
        app.onError(ErrorMiddleware)

        const response = await app.request(`/pty/${PtyID.ascending()}/connect?ticket=missing`)

        expect(response.status).toBe(401)
      },
    })
  })

  test("accepts a valid connect ticket once", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Pty.create({
          command: "/bin/sh",
          args: ["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
          title: "ticket-connect",
        })
        try {
          const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
          app.onError(ErrorMiddleware)
          const issued = PtyTicket.issue({ ptyID: info.id })

          const first = await app.request(`/pty/${info.id}/connect?ticket=${encodeURIComponent(issued.ticket)}`)
          const second = await app.request(`/pty/${info.id}/connect?ticket=${encodeURIComponent(issued.ticket)}`)

          expect(first.status).toBe(200)
          expect(await first.text()).toBe("upgraded")
          expect(second.status).toBe(401)
        } finally {
          await Pty.remove(info.id)
        }
      },
    })
  })

  test("consumes a valid ticket when it is presented for the wrong PTY", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await Pty.create({
          command: "/bin/sh",
          args: ["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
          title: "ticket-wrong-pty",
        })
        try {
          const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
          app.onError(ErrorMiddleware)
          const issued = PtyTicket.issue({ ptyID: info.id })

          const wrong = await app.request(
            `/pty/${PtyID.ascending()}/connect?ticket=${encodeURIComponent(issued.ticket)}`,
          )
          const replay = await app.request(`/pty/${info.id}/connect?ticket=${encodeURIComponent(issued.ticket)}`)

          expect(wrong.status).toBe(401)
          expect(replay.status).toBe(401)
        } finally {
          await Pty.remove(info.id)
        }
      },
    })
  })

  test("consumes a valid ticket before reporting a deleted PTY target", async () => {
    const ptyID = PtyID.ascending()
    const issued = PtyTicket.issue({ ptyID })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
        app.onError(ErrorMiddleware)

        const missing = await app.request(`/pty/${ptyID}/connect?ticket=${encodeURIComponent(issued.ticket)}`)
        const replay = await app.request(`/pty/${ptyID}/connect?ticket=${encodeURIComponent(issued.ticket)}`)

        expect(missing.status).toBe(404)
        expect(replay.status).toBe(401)
      },
    })
  })

  test("openapi documents connect tokens and websocket query parameters", async () => {
    const spec = await Server.openapi()
    const tokenResponse = spec.paths?.["/pty/{ptyID}/connect-token"]?.post?.responses?.["200"] as
      | { content?: unknown }
      | undefined

    expect(tokenResponse?.content).toBeTruthy()

    const parameters = spec.paths?.["/pty/{ptyID}/connect"]?.get?.parameters ?? []
    const names = parameters.map((parameter) => ("name" in parameter ? parameter.name : undefined))

    expect(names).toContain("cursor")
    expect(names).toContain("ticket")
  })

  test("maps missing update targets as not found", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
        app.onError(ErrorMiddleware)

        const response = await app.request(`/pty/${PtyID.ascending()}`, {
          method: "PUT",
          body: JSON.stringify({ title: "gone" }),
          headers: { "content-type": "application/json" },
        })
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.name).toBe("NotFoundError")
      },
    })
  })

  test("maps missing remove targets as not found", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = new Hono().route("/pty", PtyRoutes(testUpgradeWebSocket))
        app.onError(ErrorMiddleware)

        const response = await app.request(`/pty/${PtyID.ascending()}`, {
          method: "DELETE",
        })
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.name).toBe("NotFoundError")
      },
    })
  })
})
