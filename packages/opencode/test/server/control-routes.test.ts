import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Log } from "@opencode-ai/core/util/log"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { AppRuntime } from "../../src/effect/app-runtime"
import { ControlApi } from "../../src/server/routes/instance/httpapi/groups/control"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"

const testProviderID = "httpapi-control-provider"

afterEach(async () => {
  await Auth.remove(testProviderID).catch(() => {})
})

describe("control routes", () => {
  function requestControlHttpApi(path: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(ControlApi).pipe(
              Layer.provide(controlHandlers),
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

  test("declares auth and log control routes as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(ControlApi) as any

    expect(spec.paths).toHaveProperty("/auth/{providerID}")
    expect(spec.paths).toHaveProperty("/log")
    expect(spec.paths).not.toHaveProperty("/doc")
    expect(spec.paths["/auth/{providerID}"]).toHaveProperty("put")
    expect(spec.paths["/auth/{providerID}"]).toHaveProperty("delete")
    expect(spec.paths["/log"]).toHaveProperty("post")
  })

  test("sets and removes auth credentials through the HttpApi handlers", async () => {
    const setResponse = await requestControlHttpApi(`/auth/${testProviderID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key: "sk-httpapi-control" }),
    })

    expect(setResponse.status).toBe(200)
    expect(await setResponse.json()).toBe(true)
    expect(await Auth.get(testProviderID)).toEqual({ type: "api", key: "sk-httpapi-control" })

    const removeResponse = await requestControlHttpApi(`/auth/${testProviderID}`, { method: "DELETE" })

    expect(removeResponse.status).toBe(200)
    expect(await removeResponse.json()).toBe(true)
    expect(await Auth.get(testProviderID)).toBeUndefined()
  })

  test("writes log entries through the HttpApi handlers", async () => {
    const logger = Log.create({ service: "httpapi-control-test" })
    const original = {
      debug: logger.debug,
      info: logger.info,
      error: logger.error,
      warn: logger.warn,
    }
    const calls: Array<{ level: string; message: unknown; extra: unknown }> = []
    logger.debug = (message, extra) => {
      calls.push({ level: "debug", message, extra })
    }
    logger.info = (message, extra) => {
      calls.push({ level: "info", message, extra })
    }
    logger.error = (message, extra) => {
      calls.push({ level: "error", message, extra })
    }
    logger.warn = (message, extra) => {
      calls.push({ level: "warn", message, extra })
    }

    try {
      for (const level of ["debug", "info", "error", "warn"] as const) {
        const response = await requestControlHttpApi("/log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            service: "httpapi-control-test",
            level,
            message: `control ${level}`,
            extra: { source: "httpapi" },
          }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)
      }
      expect(calls).toEqual([
        { level: "debug", message: "control debug", extra: { source: "httpapi" } },
        { level: "info", message: "control info", extra: { source: "httpapi" } },
        { level: "error", message: "control error", extra: { source: "httpapi" } },
        { level: "warn", message: "control warn", extra: { source: "httpapi" } },
      ])
    } finally {
      logger.debug = original.debug
      logger.info = original.info
      logger.error = original.error
      logger.warn = original.warn
    }
  })

  test("rejects invalid log JSON through the HttpApi handlers", async () => {
    const response = await requestControlHttpApi("/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        service: "httpapi-control-test",
        level: "verbose",
        message: "control verbose",
      }),
    })
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      data: {
        service: "httpapi-control-test",
        level: "verbose",
        message: "control verbose",
      },
      success: false,
    })
    expect(body.error).toBeArray()
  })

  test("rejects malformed log JSON through the HttpApi handlers", async () => {
    const response = await requestControlHttpApi("/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe("Malformed JSON in request body")
  })
})
