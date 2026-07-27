import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { VOLCENGINE_PLAN_DEFAULT_MODEL_ID, VOLCENGINE_PLAN_PROVIDER_ID } from "@opencode-ai/util/volcengine-plan"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { ProviderApi } from "../../src/server/routes/instance/httpapi/groups/provider"
import { providerHandlers } from "../../src/server/routes/instance/httpapi/handlers/provider"
import { tmpdir } from "../fixture/fixture"

const modelFile = () => path.join(Global.Path.state, "model.json")
const setEnv = (key: string, value: string) => AppRuntime.runSync(Env.Service.use((env) => env.set(key, value)))

afterEach(async () => {
  await Instance.disposeAll()
  await fs.rm(modelFile(), { force: true })
})

describe("provider routes", () => {
  type ProviderClient = {
    provider: {
      list: (input?: { query?: { directory?: string; workspace?: string } }) => Effect.Effect<
        {
          all: ReadonlyArray<{ id: string; canFetchModels: boolean }>
          default: Readonly<Record<string, string>>
          connected: ReadonlyArray<string>
        },
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
      fetchModels: (input: {
        params: { providerID: string }
        query?: { directory?: string; workspace?: string }
      }) => Effect.Effect<{ models: ReadonlyArray<{ id: string; name: string }> }, unknown, unknown>
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
            expect(providers.all.every((provider) => typeof provider.canFetchModels === "boolean")).toBe(true)
            expect(providers.all.find((provider) => provider.id === "kimi-for-coding")?.canFetchModels).toBe(true)
            expect(providers.all.find((provider) => provider.id === "opencode")?.canFetchModels).toBe(true)
            const hasVolcenginePlan = providers.all.some((provider) => provider.id === VOLCENGINE_PLAN_PROVIDER_ID)
            expect(hasVolcenginePlan).toBe(true)
            expect(providers.default[VOLCENGINE_PLAN_PROVIDER_ID]).toBe(VOLCENGINE_PLAN_DEFAULT_MODEL_ID)

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

  test("uses the resolved provider environment key for model discovery", async () => {
    const received: { apiKey: string | null } = { apiKey: null }
    await using remote = Bun.serve({
      port: 0,
      fetch(request) {
        received.apiKey = request.headers.get("x-api-key")
        return Response.json({ data: [{ id: "claude-test", display_name: "Claude Test" }] })
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          anthropic: {
            options: { endpoint: `${remote.url.origin}/v1` },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        setEnv("ANTHROPIC_API_KEY", "env-anthropic-key")
      },
      fn: async () => {
        await withProviderClient((client) =>
          Effect.gen(function* () {
            const result = yield* client.provider.fetchModels({
              params: { providerID: "anthropic" },
              query: {},
            })
            expect(result.models).toEqual([{ id: "claude-test", name: "Claude Test" }])
          }),
        )
      },
    })
    expect(received.apiKey).toBe("env-anthropic-key")
  }, 30000)

  test("uses a custom provider's configured API for model discovery", async () => {
    const received: { authorization: string | null } = { authorization: null }
    let pathname = ""
    await using remote = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        pathname = url.pathname
        received.authorization = request.headers.get("authorization")
        return Response.json({ data: [{ id: "custom-live-model" }] })
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          "custom-gateway": {
            npm: "@ai-sdk/openai-compatible",
            api: `${remote.url.origin}/v1`,
            env: ["CUSTOM_GATEWAY_KEY"],
            models: {
              "configured-model": {
                limit: { context: 128_000, output: 4_096 },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        setEnv("CUSTOM_GATEWAY_KEY", "env-gateway-key")
      },
      fn: async () => {
        await withProviderClient((client) =>
          Effect.gen(function* () {
            const providers = yield* client.provider.list({ query: {} })
            expect(providers.all.find((provider) => provider.id === "custom-gateway")?.canFetchModels).toBe(true)

            const result = yield* client.provider.fetchModels({
              params: { providerID: "custom-gateway" },
              query: {},
            })
            expect(result.models).toEqual([{ id: "custom-live-model", name: "custom-live-model" }])
          }),
        )
      },
    })

    expect(pathname).toBe("/v1/models")
    expect(received.authorization).toBe("Bearer env-gateway-key")
  }, 30000)

  test("uses a custom model's configured API for model discovery", async () => {
    let pathname = ""
    await using remote = Bun.serve({
      port: 0,
      fetch(request) {
        pathname = new URL(request.url).pathname
        return Response.json({ data: [{ id: "model-api-live" }] })
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          "model-api-gateway": {
            env: ["MODEL_API_GATEWAY_KEY"],
            models: {
              "configured-model": {
                provider: {
                  npm: "@ai-sdk/openai-compatible",
                  api: `${remote.url.origin}/v1`,
                },
                limit: { context: 128_000, output: 4_096 },
              },
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        setEnv("MODEL_API_GATEWAY_KEY", "env-model-api-key")
      },
      fn: async () => {
        await withProviderClient((client) =>
          Effect.gen(function* () {
            const providers = yield* client.provider.list({ query: {} })
            expect(providers.all.find((provider) => provider.id === "model-api-gateway")?.canFetchModels).toBe(true)

            const result = yield* client.provider.fetchModels({
              params: { providerID: "model-api-gateway" },
              query: {},
            })
            expect(result.models).toEqual([{ id: "model-api-live", name: "model-api-live" }])
          }),
        )
      },
    })

    expect(pathname).toBe("/v1/models")
  }, 30000)

  test("uses an explicit MiniMax endpoint instead of sending its key to the official host", async () => {
    const received: { authorization: string | null } = { authorization: null }
    let pathname = ""
    await using remote = Bun.serve({
      port: 0,
      fetch(request) {
        pathname = new URL(request.url).pathname
        received.authorization = request.headers.get("authorization")
        return Response.json({ data: [{ id: "proxied-minimax-model" }] })
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          minimax: {
            options: { endpoint: `${remote.url.origin}/openai/v1` },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        setEnv("MINIMAX_API_KEY", "proxy-minimax-key")
      },
      fn: async () => {
        await withProviderClient((client) =>
          Effect.gen(function* () {
            const result = yield* client.provider.fetchModels({
              params: { providerID: "minimax" },
              query: {},
            })
            expect(result.models).toEqual([{ id: "proxied-minimax-model", name: "proxied-minimax-model" }])
          }),
        )
      },
    })

    expect(pathname).toBe("/openai/v1/models")
    expect(received.authorization).toBe("Bearer proxy-minimax-key")
  }, 30000)

  test("does not offer API model discovery for OpenAI OAuth", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await AppRuntime.runPromise(
          Auth.Service.use((auth) =>
            auth.set("openai", {
              type: "oauth",
              refresh: "refresh-token",
              access: "access-token",
              expires: Date.now() + 60_000,
            }),
          ),
        )
      },
      fn: async () => {
        await withProviderClient((client) =>
          Effect.gen(function* () {
            const providers = yield* client.provider.list({ query: {} })
            expect(providers.connected).toContain("openai")
            expect(providers.all.find((provider) => provider.id === "openai")?.canFetchModels).toBe(false)
          }),
        )
      },
    })
  }, 30000)
})
