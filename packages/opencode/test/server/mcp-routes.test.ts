import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Instance } from "../../src/project/instance"
import { McpRoutes } from "../../src/server/instance/mcp"
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
})
