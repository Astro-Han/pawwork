import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import { Hono } from "hono"
import path from "path"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { VOLCENGINE_PLAN_DEFAULT_MODEL_ID, VOLCENGINE_PLAN_PROVIDER_ID } from "@opencode-ai/util/volcengine-plan"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ProviderRoutes } from "../../src/server/instance/provider"
import { ProviderApi } from "../../src/server/routes/instance/httpapi/groups/provider"
import { providerHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider"
import { tmpdir } from "../fixture/fixture"

const modelFile = () => path.join(Global.Path.state, "model.json")

afterEach(async () => {
  await Instance.disposeAll()
  await fs.rm(modelFile(), { force: true })
})

describe("provider routes", () => {
  function app() {
    return new Hono().route("/provider", ProviderRoutes())
  }

  type ProviderClient = {
    provider: {
      list: (input?: { query?: { directory?: string; workspace?: string } }) => Effect.Effect<
        { all: ReadonlyArray<unknown>; default: Readonly<Record<string, string>>; connected: ReadonlyArray<string> },
        unknown,
        unknown
      >
      auth: (input?: { query?: { directory?: string; workspace?: string } }) => Effect.Effect<
        Record<string, ReadonlyArray<{ label: string }>>,
        unknown,
        unknown
      >
      authorize: (input: {
        params: { providerID: string }
        query?: { directory?: string; workspace?: string }
        payload: { method: number; inputs?: Record<string, string> }
      }) => Effect.Effect<{ url: string; method: "auto" | "code"; instructions: string } | undefined, unknown, unknown>
      callback: (input: {
        params: { providerID: string }
        query?: { directory?: string; workspace?: string }
        payload: { method: number; code?: string }
      }) => Effect.Effect<boolean, unknown, unknown>
      recent: (input: {
        query?: { directory?: string; workspace?: string }
        payload: { providerID: string; modelID: string }
      }) => Effect.Effect<boolean, unknown, unknown>
    }
  }

  function withProviderClient<A>(fn: (client: ProviderClient) => Effect.Effect<A, unknown, unknown>) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpApiTest.groups(ProviderApi, ["provider"])
          return yield* fn(client as unknown as ProviderClient)
        }).pipe(
          Effect.provide(providerHandlers),
          Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
        ),
      ) as Effect.Effect<A>,
    )
  }

  function requestProviderHttpApi(pathname: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(ProviderApi).pipe(
              Layer.provide(providerHandlers),
              Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
            ),
          )
          const request = HttpServerRequest.fromWeb(new Request(`http://localhost${pathname}`, init))
          const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
          return HttpServerResponse.toWeb(response)
        }),
      ) as Effect.Effect<Response>,
    )
  }

  async function writeRouteAuthPlugin(dir: string) {
    const pluginDir = path.join(dir, ".opencode", "plugin")
    await fs.mkdir(pluginDir, { recursive: true })
    await Bun.write(
      path.join(pluginDir, "route-auth.ts"),
      [
        "export default {",
        '  id: "test.route-auth",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "route-auth",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "Route OAuth",',
        "          authorize: async () => ({",
        '            url: "https://example.com/oauth",',
        '            method: "code",',
        '            instructions: "Enter code",',
        "            callback: async (code) =>",
        "              code === 'ok'",
        "                ? { type: 'success', key: 'route-key' }",
        "                : { type: 'failure' },",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  }

  test("declares the provider route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(ProviderApi) as any

    expect(spec.paths).toHaveProperty("/provider")
    expect(spec.paths).toHaveProperty("/provider/auth")
    expect(spec.paths).toHaveProperty("/provider/{providerID}/oauth/authorize")
    expect(spec.paths).toHaveProperty("/provider/{providerID}/oauth/callback")
    expect(spec.paths).toHaveProperty("/provider/recent")
    expect(spec.paths["/provider"]).toHaveProperty("get")
    expect(spec.paths["/provider/auth"]).toHaveProperty("get")
    expect(spec.paths["/provider/{providerID}/oauth/authorize"]).toHaveProperty("post")
    expect(spec.paths["/provider/{providerID}/oauth/callback"]).toHaveProperty("post")
    expect(spec.paths["/provider/recent"]).toHaveProperty("post")

    expect(spec.paths["/provider/{providerID}/oauth/authorize"]?.post?.parameters).toContainEqual({
      name: "providerID",
      in: "path",
      required: true,
      schema: { type: "string" },
    })
    expect(spec.paths["/provider/{providerID}/oauth/authorize"]?.post?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["method"],
            properties: {
              method: expect.any(Object),
              inputs: expect.any(Object),
            },
          },
        },
      },
    })
    expect(spec.paths["/provider/{providerID}/oauth/callback"]?.post?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["method"],
            properties: {
              method: expect.any(Object),
              code: expect.any(Object),
            },
          },
        },
      },
    })
    expect(spec.paths["/provider/recent"]?.post?.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["providerID", "modelID"],
            properties: {
              providerID: { type: "string" },
              modelID: { type: "string" },
            },
          },
        },
      },
    })
  })

  test("lists providers through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/provider")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.all).toBeArray()
        expect(body.default).toBeObject()
        expect(body.connected).toBeArray()
        expect(body.all.some((provider: { id: string }) => provider.id === VOLCENGINE_PLAN_PROVIDER_ID)).toBe(true)
        expect(body.default[VOLCENGINE_PLAN_PROVIDER_ID]).toBe(VOLCENGINE_PLAN_DEFAULT_MODEL_ID)
      },
    })
  })

  test("runs provider auth routes through the route runtime", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: writeRouteAuthPlugin,
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const methods = await app().request("/provider/auth")
        const methodsBody = await methods.json()
        const authorize = await app().request("/provider/route-auth/oauth/authorize", {
          method: "POST",
          body: JSON.stringify({ method: 0 }),
          headers: { "content-type": "application/json" },
        })
        const authorizeBody = await authorize.json()
        const callback = await app().request("/provider/route-auth/oauth/callback", {
          method: "POST",
          body: JSON.stringify({ method: 0, code: "ok" }),
          headers: { "content-type": "application/json" },
        })
        const callbackBody = await callback.json()

        expect(methods.status).toBe(200)
        expect(methodsBody["route-auth"][0].label).toBe("Route OAuth")
        expect(authorize.status).toBe(200)
        expect(authorizeBody.url).toBe("https://example.com/oauth")
        expect(callback.status).toBe(200)
        expect(callbackBody).toBe(true)
      },
    })
  }, 30000)

  test("serves provider list, auth, oauth, and recent through the HttpApi handlers", async () => {
    await fs.mkdir(Global.Path.state, { recursive: true })
    await using tmp = await tmpdir({ git: true, init: writeRouteAuthPlugin })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await withProviderClient((client) =>
          Effect.gen(function* () {
            const providers = yield* client.provider.list({ query: {} })
            expect(providers.all).toBeArray()
            expect(providers.default).toBeObject()
            expect(providers.connected).toBeArray()

            const methods = yield* client.provider.auth({ query: {} })
            expect(methods["route-auth"][0].label).toBe("Route OAuth")

            const authorization = yield* client.provider.authorize({
              params: { providerID: "route-auth" },
              query: {},
              payload: { method: 0 },
            })
            expect(authorization?.url).toBe("https://example.com/oauth")

            expect(
              yield* client.provider.callback({
                params: { providerID: "route-auth" },
                query: {},
                payload: { method: 0, code: "ok" },
              }),
            ).toBe(true)

            expect(
              yield* client.provider.recent({
                query: {},
                payload: { providerID: "deepseek", modelID: "deepseek-chat" },
              }),
            ).toBe(true)
          }),
        )

        const recent = JSON.parse(await fs.readFile(modelFile(), "utf-8")).recent
        expect(recent[0]).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
      },
    })
  }, 30000)

  test("maps provider auth failures to 400 through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true, init: writeRouteAuthPlugin })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestProviderHttpApi("/provider/route-auth/oauth/callback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: 0, code: "ok" }),
        })
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.name).toBe("ProviderAuthOauthMissing")
      },
    })
  }, 30000)
})
