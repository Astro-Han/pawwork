import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Deferred, Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { PermissionApi } from "../../src/server/routes/instance/httpapi/groups/permission"
import { permissionHandlers } from "../../src/server/routes/instance/httpapi/handlers/permission"
import { SessionApi } from "../../src/server/routes/instance/httpapi/groups/session"
import { sessionHandlers } from "../../src/server/routes/instance/httpapi/handlers/session"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("permission routes", () => {
  function requestPermissionHttpApi(path: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(PermissionApi).pipe(
              Layer.provide(permissionHandlers),
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

  function requestSessionHttpApi(path: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(SessionApi).pipe(
              Layer.provide(sessionHandlers),
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

  test("declares the permission route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(PermissionApi) as any

    expect(spec.paths).toHaveProperty("/permission")
    expect(spec.paths).toHaveProperty("/permission/{requestID}/reply")
    expect(spec.paths).toHaveProperty("/permission/__e2e/ask")
    expect(spec.paths["/permission"]).toHaveProperty("get")
    expect(spec.paths["/permission/{requestID}/reply"]).toHaveProperty("post")
    expect(spec.paths["/permission/__e2e/ask"]).toHaveProperty("post")
  })

  test("lists permissions and replies to pending permissions through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const listResponse = await requestPermissionHttpApi("/permission")
        expect(listResponse.status).toBe(200)
        expect(await listResponse.json()).toEqual([])

        const session = await AppRuntime.runPromise(Session.Service.use((service) => service.create({})))
        const requestID = PermissionID.ascending()
        const pending = await AppRuntime.runPromise(Deferred.make<void>())
        const asked = AppRuntime.runPromise(
          Permission.Service.use((permission) =>
            permission.ask({
              id: requestID,
              sessionID: session.id,
              permission: "bash",
              patterns: ["echo ok"],
              metadata: {},
              always: ["echo ok"],
              ruleset: [{ permission: "bash", pattern: "echo ok", action: "ask" }],
              onPending: () => Deferred.succeed(pending, undefined),
            }),
          ),
        )

        await AppRuntime.runPromise(Deferred.await(pending))

        const pendingListResponse = await requestPermissionHttpApi("/permission")
        expect(pendingListResponse.status).toBe(200)
        expect(await pendingListResponse.json()).toMatchObject([
          {
            id: requestID,
            sessionID: session.id,
            permission: "bash",
            patterns: ["echo ok"],
            metadata: {},
            always: ["echo ok"],
          },
        ])

        const replyResponse = await requestPermissionHttpApi(`/permission/${requestID}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "once" }),
        })

        expect(replyResponse.status).toBe(200)
        expect(await replyResponse.json()).toBe(true)
        await expect(asked).resolves.toBeUndefined()
      },
    })
  })

  test("keeps the e2e permission ask gate closed through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPermissionHttpApi("/permission/__e2e/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: SessionID.descending(),
            permission: "bash",
            patterns: ["echo ok"],
          }),
        })

        expect(response.status).toBe(404)
      },
    })
  })

  test("rejects malformed reply JSON through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPermissionHttpApi(`/permission/${PermissionID.ascending()}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })

        expect(response.status).toBe(400)
        expect(await response.text()).toBe("Malformed JSON in request body")
      },
    })
  })

  test("returns 404 for an unknown permission request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestPermissionHttpApi(`/permission/${PermissionID.ascending()}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "once" }),
        })

        expect(response.status).toBe(404)
      },
    })
  })

  test("replies through the deprecated session permission route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.descending()
        const requestID = PermissionID.ascending()
        const pending = await AppRuntime.runPromise(Deferred.make<void>())
        const asked = AppRuntime.runPromise(
          Permission.Service.use((permission) =>
            permission.ask({
              id: requestID,
              sessionID,
              permission: "bash",
              patterns: ["echo ok"],
              metadata: {},
              always: ["echo ok"],
              ruleset: [{ permission: "bash", pattern: "echo ok", action: "ask" }],
              onPending: () => Deferred.succeed(pending, undefined),
            }),
          ),
        )

        await AppRuntime.runPromise(Deferred.await(pending))

        try {
          const response = await requestSessionHttpApi(`/session/${sessionID}/permissions/${requestID}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response: "once" }),
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          await expect(asked).resolves.toBeUndefined()
        } finally {
          await AppRuntime.runPromise(
            Permission.Service.use((permission) => permission.reply({ requestID, reply: "reject" })),
          ).catch(() => undefined)
          await asked.catch(() => undefined)
        }
      },
    })
  })
})
