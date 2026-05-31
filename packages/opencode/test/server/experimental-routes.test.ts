import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { ExperimentalRoutes } from "../../src/server/instance/experimental"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("experimental routes", () => {
  function app() {
    return new Hono().route("/experimental", ExperimentalRoutes())
  }

  test("lists tool IDs through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/tool/ids")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeArray()
      },
    })
  })

  test("lists worktrees through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/worktree")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeArray()
      },
    })
  })

  test("lists MCP resources through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/resource")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeObject()
      },
    })
  })
})
