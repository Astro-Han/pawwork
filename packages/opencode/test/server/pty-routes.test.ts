import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { assertPtyConnectTarget, PtyRoutes } from "../../src/server/instance/pty"
import { ErrorMiddleware } from "../../src/server/middleware"
import { NotFoundError } from "../../src/storage/db"
import { Pty } from "../../src/pty"
import { PtyID } from "../../src/pty/schema"
import { PtyTicket } from "../../src/pty/ticket"
import { Instance } from "../../src/project/instance"
import { PtyApi } from "../../src/server/routes/instance/httpapi/groups/pty"
import { ptyHandlers } from "../../src/server/routes/instance/httpapi/handlers/pty"
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
  function requestPtyHttpApi(path: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(PtyApi).pipe(
              Layer.provide(ptyHandlers),
              Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
            ),
          )
          const request = HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, init))
          const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
          return HttpServerResponse.toWeb(response)
        }),
      ) as Effect.Effect<Response>,
    )
  }

  test("declares the PTY JSON route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(PtyApi) as any

    expect(spec.paths).toHaveProperty("/pty/shells")
    expect(spec.paths).toHaveProperty("/pty")
    expect(spec.paths).toHaveProperty("/pty/{ptyID}")
    expect(spec.paths).toHaveProperty("/pty/{ptyID}/connect-token")
    expect(spec.paths).not.toHaveProperty("/pty/{ptyID}/connect")
    expect(spec.paths["/pty/shells"]).toHaveProperty("get")
    expect(spec.paths["/pty"]).toHaveProperty("get")
    expect(spec.paths["/pty"]).toHaveProperty("post")
    expect(spec.paths["/pty/{ptyID}"]).toHaveProperty("get")
    expect(spec.paths["/pty/{ptyID}"]).toHaveProperty("put")
    expect(spec.paths["/pty/{ptyID}"]).toHaveProperty("delete")
    expect(spec.paths["/pty/{ptyID}/connect-token"]).toHaveProperty("post")

    const connectTokenSchema =
      spec.paths["/pty/{ptyID}/connect-token"].post.responses["200"].content["application/json"].schema.properties
        .expires_in
    expect(connectTokenSchema.type).toBe("integer")
    expect(connectTokenSchema.allOf).toContainEqual({ exclusiveMinimum: 0 })
  })

  test("serves PTY list, create, get, update, connect-token, and remove through the HttpApi handlers", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initial = await requestPtyHttpApi("/pty")
        expect(initial.status).toBe(200)
        expect(await initial.json()).toEqual([])

        const createdResponse = await requestPtyHttpApi("/pty", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            command: "/bin/sh",
            args: ["-c", "trap 'exit 0' TERM; while :; do sleep 1; done"],
            title: "httpapi-pty",
          }),
        })
        expect(createdResponse.status).toBe(200)
        const created = (await createdResponse.json()) as Pty.Info
        expect(created.title).toBe("httpapi-pty")

        try {
          const getResponse = await requestPtyHttpApi(`/pty/${created.id}`)
          expect(getResponse.status).toBe(200)
          expect(await getResponse.json()).toMatchObject({ id: created.id, title: "httpapi-pty" })

          const updateResponse = await requestPtyHttpApi(`/pty/${created.id}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "renamed-httpapi-pty" }),
          })
          expect(updateResponse.status).toBe(200)
          expect(await updateResponse.json()).toMatchObject({ id: created.id, title: "renamed-httpapi-pty" })

          const tokenResponse = await requestPtyHttpApi(`/pty/${created.id}/connect-token`, { method: "POST" })
          expect(tokenResponse.status).toBe(200)
          const token = await tokenResponse.json()
          expect(token.ticket).toBeString()
          expect(token.expires_in).toBe(60)

          const removeResponse = await requestPtyHttpApi(`/pty/${created.id}`, { method: "DELETE" })
          expect(removeResponse.status).toBe(200)
          expect(await removeResponse.json()).toBe(true)
        } finally {
          await Pty.remove(created.id)
        }
      },
    })
  })

  test("serves available shells through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPtyHttpApi("/pty/shells")
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body).toBeArray()
        expect(body.length).toBeGreaterThan(0)
        expect(body[0]).toMatchObject({
          path: expect.any(String),
          name: expect.any(String),
          acceptable: expect.any(Boolean),
        })
      },
    })
  })

  test("maps missing PTY HttpApi targets as not found", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = PtyID.ascending()

        for (const [path, init, message] of [
          [`/pty/${id}`, undefined, "Session not found"],
          [
            `/pty/${id}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: "gone" }),
            },
            "Session not found",
          ],
          [`/pty/${id}`, { method: "DELETE" }, "Session not found"],
          [`/pty/${id}/connect-token`, { method: "POST" }, "PTY session not found"],
        ] as const) {
          const response = await requestPtyHttpApi(path, init)
          const body = await response.json()

          expect(response.status).toBe(404)
          expect(body).toEqual({
            name: "NotFoundError",
            data: { message },
          })
        }
      },
    })
  })

  test("rejects malformed PTY ids through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPtyHttpApi("/pty/not-a-pty")
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body).toMatchObject({
          data: { ptyID: "not-a-pty" },
          success: false,
        })
        expect(body.error).toBeArray()
      },
    })
  })

  test("rejects invalid PTY create JSON through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPtyHttpApi("/pty", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args: "not-an-array" }),
        })
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body).toMatchObject({
          data: { args: "not-an-array" },
          success: false,
        })
        expect(body.error).toBeArray()
      },
    })
  })

  test("rejects malformed PTY create JSON through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPtyHttpApi("/pty", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })

        expect(response.status).toBe(400)
        expect(await response.text()).toBe("Malformed JSON in request body")
      },
    })
  })

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
    const names = parameters.map((parameter: { name?: string }) => parameter.name)

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
