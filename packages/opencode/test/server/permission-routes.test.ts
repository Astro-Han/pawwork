import { afterEach, describe, expect, test } from "bun:test"
import { Deferred } from "effect"
import { Hono } from "hono"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { PermissionRoutes } from "../../src/server/instance/permission"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("permission routes", () => {
  function app() {
    return new Hono().route("/permission", PermissionRoutes())
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
})
