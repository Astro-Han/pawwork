import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Log } from "@opencode-ai/core/util/log"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { AppRuntime } from "../../src/effect/app-runtime"
import { ConfigApi } from "../../src/server/routes/instance/httpapi/groups/config"
import { configHandlers } from "../../src/server/routes/instance/httpapi/handlers/config"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("config routes", () => {
  function requestProductionConfig(directory: string, path: string, init?: RequestInit) {
    const separator = path.includes("?") ? "&" : "?"
    return Server.Default().app.request(`${path}${separator}directory=${encodeURIComponent(directory)}`, init)
  }

  type ConfigClient = {
    config: {
      get: (input?: { query?: { directory?: string; workspace?: string } }) => Effect.Effect<unknown, unknown, unknown>
      update: (input: {
        query?: { directory?: string; workspace?: string }
        payload: { username: string; unexpected?: unknown }
      }) => Effect.Effect<unknown, unknown, unknown>
      providers: (input?: {
        query?: { directory?: string; workspace?: string }
      }) => Effect.Effect<{ providers: ReadonlyArray<unknown>; default: Readonly<Record<string, string>> }, unknown, unknown>
    }
  }

  function withConfigClient<A>(fn: (client: ConfigClient) => Effect.Effect<A, unknown, unknown>) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpApiTest.groups(ConfigApi, ["config"])
          return yield* fn(client as unknown as ConfigClient)
        }).pipe(
          Effect.provide(configHandlers),
          Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
        ),
      ) as Effect.Effect<A>,
    )
  }

  function requestConfigHttpApi(
    path: string,
    options: {
      init?: RequestInit
      services?: {
        config: Config.Interface
        provider: Provider.Interface
      }
    } = {},
  ) {
    const serviceLayer = options.services
      ? Layer.mergeAll(
          Layer.succeed(Config.Service, options.services.config),
          Layer.succeed(Provider.Service, options.services.provider),
        )
      : Layer.empty
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(ConfigApi).pipe(
              Layer.provide(configHandlers),
              Layer.provide(
                Layer.mergeAll(serviceLayer, NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer),
              ),
            ),
          )
          const request = HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, options.init))
          const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
          return HttpServerResponse.toWeb(response)
        }),
      ) as Effect.Effect<Response>,
    )
  }

  function unusedProvider(): Provider.Interface {
    const unused = () => Effect.die(new Error("unused provider method"))
    return {
      list: () => Effect.succeed({}),
      getProvider: unused,
      getModel: unused,
      getLanguage: unused,
      closest: unused,
      getSmallModel: unused,
      defaultModel: unused,
    } as Provider.Interface
  }

  test("declares the config route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(ConfigApi) as any

    expect(spec.paths).toHaveProperty("/config")
    expect(spec.paths).toHaveProperty("/config/providers")
    expect(spec.paths["/config"]).toHaveProperty("get")
    expect(spec.paths["/config"]).toHaveProperty("patch")
    expect(spec.paths["/config/providers"]).toHaveProperty("get")

    for (const operation of [
      spec.paths["/config"]?.get,
      spec.paths["/config"]?.patch,
      spec.paths["/config/providers"]?.get,
    ]) {
      expect(operation?.parameters).toEqual([
        { name: "directory", in: "query", required: false, schema: { type: "string" } },
        { name: "workspace", in: "query", required: false, schema: { type: "string" } },
      ])
    }

    expect(spec.paths["/config"]?.patch?.requestBody).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/Config" } } },
    })
    expect(spec.paths["/config"]?.patch?.responses?.["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/Config" } } },
    })
    expect(spec.paths["/config"]?.patch?.responses?.["400"]).toMatchObject({
      description: "Bad request",
      content: { "application/json": { schema: { $ref: "#/components/schemas/BadRequestError" } } },
    })
  })

  test("reads config through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toBeObject()
  })

  test("lists configured providers through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config/providers")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.providers).toBeArray()
    expect(body.default).toBeObject()
  })

  test("updates config through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "route-runtime-tester" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ username: "route-runtime-tester" })

    const reread = await requestProductionConfig(tmp.path, "/config")
    expect(reread.status).toBe(200)
    expect(await reread.json()).toMatchObject({ username: "route-runtime-tester" })
  })

  test("rejects unknown config fields through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "route-runtime-tester", unexpected: true }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      data: { username: "route-runtime-tester", unexpected: true },
      error: [
        {
          code: "unrecognized_keys",
          keys: ["unexpected"],
          path: [],
          message: 'Unrecognized key: "unexpected"',
        },
      ],
      success: false,
    })
  })

  test("ignores patch bodies without a json content type through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ username: "route-runtime-text-body" }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({})
  })

  test("accepts vendor json patch bodies through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config", {
      method: "PATCH",
      headers: { "content-type": "application/vnd.opencode.config+json" },
      body: JSON.stringify({ username: "route-runtime-vendor-json" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ username: "route-runtime-vendor-json" })
  })

  test("accepts json patch bodies with content type parameters through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config", {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ username: "route-runtime-json-params" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ username: "route-runtime-json-params" })
  })

  test("rejects malformed json patch bodies through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await requestProductionConfig(tmp.path, "/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toBe("Malformed JSON in request body")
  })

  test("serves get, update, and providers through the HttpApi config handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await withConfigClient((client) =>
          Effect.gen(function* () {
            expect(yield* client.config.get({ query: {} })).toBeObject()
            expect(
              yield* client.config.update({ query: {}, payload: { username: "httpapi-route-runtime-tester" } }),
            ).toMatchObject({
              username: "httpapi-route-runtime-tester",
            })
            expect(yield* client.config.get({ query: {} })).toMatchObject({ username: "httpapi-route-runtime-tester" })

            const providers = yield* client.config.providers({ query: {} })
            expect(providers.providers).toBeArray()
            expect(providers.default).toBeObject()
          }),
        )
      },
    })
  })

  test("preserves derived config fields through the HttpApi get handler", async () => {
    const config = {
      username: "httpapi-derived-field-tester",
      plugin_origins: [{ spec: "local-plugin@1.0.0", source: "/tmp/opencode.json", scope: "local" }],
    } satisfies Config.Info
    const response = await requestConfigHttpApi("/config", {
      services: {
        config: {
          get: () => Effect.succeed(config),
          getGlobal: () => Effect.succeed({}),
          getConsoleState: () => Effect.succeed({} as never),
          update: () => Effect.void,
          updateGlobal: (next) => Effect.succeed(next),
          invalidate: () => Effect.void,
          directories: () => Effect.succeed([]),
          waitForDependencies: () => Effect.void,
          installDependencies: () => Effect.succeed(true),
        },
        provider: unusedProvider(),
      },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      username: "httpapi-derived-field-tester",
      plugin_origins: [{ spec: "local-plugin@1.0.0", source: "/tmp/opencode.json", scope: "local" }],
    })
  })

  test("rejects unknown config fields through the HttpApi config handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestConfigHttpApi("/config", {
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "httpapi-route-runtime-tester", unexpected: true }),
          },
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          data: { username: "httpapi-route-runtime-tester", unexpected: true },
          error: [
            {
              code: "unrecognized_keys",
              keys: ["unexpected"],
              path: [],
              message: 'Unrecognized key: "unexpected"',
            },
          ],
          success: false,
        })
      },
    })
  })

  test("ignores patch bodies without a json content type through the HttpApi config handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestConfigHttpApi("/config", {
          init: {
            method: "PATCH",
            headers: { "content-type": "text/plain" },
            body: JSON.stringify({ username: "httpapi-route-runtime-text-body" }),
          },
        })
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toEqual({})
      },
    })
  })

  test("accepts vendor json patch bodies through the HttpApi config handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestConfigHttpApi("/config", {
          init: {
            method: "PATCH",
            headers: { "content-type": "application/vnd.opencode.config+json" },
            body: JSON.stringify({ username: "httpapi-route-runtime-vendor-json" }),
          },
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ username: "httpapi-route-runtime-vendor-json" })
      },
    })
  })

  test("accepts json patch bodies with content type parameters through the HttpApi config handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestConfigHttpApi("/config", {
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ username: "httpapi-route-runtime-json-params" }),
          },
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ username: "httpapi-route-runtime-json-params" })
      },
    })
  })

  test("rejects malformed json patch bodies through the HttpApi config handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestConfigHttpApi("/config", {
          init: {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: "{",
          },
        })

        expect(response.status).toBe(400)
        expect(await response.text()).toBe("Malformed JSON in request body")
      },
    })
  })
})
