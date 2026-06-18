import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { McpRoutes } from "../../src/server/instance/mcp"
import { McpApi } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { mcpHandlers } from "../../src/server/routes/instance/httpapi/handlers/mcp"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("MCP routes", () => {
  function app() {
    return new Hono().route("/mcp", McpRoutes())
  }

  async function addDisabledLocalServer(name: string) {
    return app().request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        config: {
          type: "local",
          command: ["echo", "test"],
          enabled: false,
        },
      }),
    })
  }

  function requestMcpHttpApi(path: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(McpApi).pipe(
              Layer.provide(mcpHandlers),
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

  async function addDisabledLocalServerHttpApi(name: string) {
    return requestMcpHttpApi("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        config: {
          type: "local",
          command: ["echo", "test"],
          enabled: false,
        },
      }),
    })
  }

  test("declares the MCP route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(McpApi) as any

    expect(spec.paths).toHaveProperty("/mcp")
    expect(spec.paths).toHaveProperty("/mcp/{name}/auth")
    expect(spec.paths).toHaveProperty("/mcp/{name}/auth/callback")
    expect(spec.paths).toHaveProperty("/mcp/{name}/auth/authenticate")
    expect(spec.paths).toHaveProperty("/mcp/{name}/connect")
    expect(spec.paths).toHaveProperty("/mcp/{name}/disconnect")
    expect(spec.paths["/mcp"]).toHaveProperty("get")
    expect(spec.paths["/mcp"]).toHaveProperty("post")
    expect(spec.paths["/mcp/{name}/auth"]).toHaveProperty("post")
    expect(spec.paths["/mcp/{name}/auth"]).toHaveProperty("delete")
    expect(spec.paths["/mcp/{name}/auth/callback"]).toHaveProperty("post")
    expect(spec.paths["/mcp/{name}/auth/authenticate"]).toHaveProperty("post")
    expect(spec.paths["/mcp/{name}/connect"]).toHaveProperty("post")
    expect(spec.paths["/mcp/{name}/disconnect"]).toHaveProperty("post")
  })

  test("returns MCP status through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/mcp")
        expect(response.status).toBe(200)
        expect(await response.json()).toBeObject()
      },
    })
  })

  test("returns MCP status through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestMcpHttpApi("/mcp")
        expect(response.status).toBe(200)
        expect(await response.json()).toBeObject()
      },
    })
  })

  test("adds a disabled local MCP server through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await addDisabledLocalServer("route-disabled")
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          "route-disabled": { status: "disabled" },
        })
      },
    })
  })

  test("adds a disabled local MCP server through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await addDisabledLocalServerHttpApi("httpapi-disabled")
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          "httpapi-disabled": { status: "disabled" },
        })
      },
    })
  })

  test("rejects malformed add JSON through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestMcpHttpApi("/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })

        expect(response.status).toBe(400)
        expect(await response.text()).toBe("Malformed JSON in request body")
      },
    })
  })

  test("keeps the non-OAuth auth start response at 400", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const added = await addDisabledLocalServer("route-disabled")
        expect(added.status).toBe(200)

        const response = await app().request("/mcp/route-disabled/auth", { method: "POST" })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: "MCP server route-disabled does not support OAuth",
        })
      },
    })
  })

  test("keeps the non-OAuth auth start response at 400 through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const added = await addDisabledLocalServerHttpApi("httpapi-disabled")
        expect(added.status).toBe(200)

        const response = await requestMcpHttpApi("/mcp/httpapi-disabled/auth", { method: "POST" })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: "MCP server httpapi-disabled does not support OAuth",
        })
      },
    })
  })

  test("returns true when disconnecting through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const added = await addDisabledLocalServerHttpApi("httpapi-disabled")
        expect(added.status).toBe(200)

        const response = await requestMcpHttpApi("/mcp/httpapi-disabled/disconnect", { method: "POST" })
        expect(response.status).toBe(200)
        expect(await response.json()).toBe(true)
      },
    })
  })
})
