import { afterEach, describe, expect, test } from "bun:test"
import { Deferred } from "effect"
import { Hono } from "hono"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { ErrorMiddleware } from "../../src/server/middleware"
import { PermissionRoutes } from "../../src/server/instance/permission"
import { SessionRoutes } from "../../src/server/instance/session"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("permission routes", () => {
  function app() {
    const instance = new Hono().route("/permission", PermissionRoutes())
    instance.onError(ErrorMiddleware)
    return instance
  }

  function sessionApp() {
    const instance = new Hono().route("/session", SessionRoutes())
    instance.onError(ErrorMiddleware)
    return instance
  }

  test("replies to a pending permission through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const requestID = PermissionID.ascending()
        const pending = await AppRuntime.runPromise(Deferred.make<void>())
        const asked = AppRuntime.runPromise(
          Permission.Service.use((permission) =>
            permission.ask({
              id: requestID,
              sessionID: SessionID.descending(),
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

        const response = await app().request(`/permission/${requestID}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply: "once" }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)
        await expect(asked).resolves.toBeUndefined()
      },
    })
  })

  test("returns 404 for an unknown permission request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request(`/permission/${PermissionID.ascending()}/reply`, {
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
          const response = await sessionApp().request(`/session/${sessionID}/permissions/${requestID}`, {
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
