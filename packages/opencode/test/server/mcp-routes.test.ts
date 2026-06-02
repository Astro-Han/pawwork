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
})
