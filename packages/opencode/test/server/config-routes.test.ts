import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { ConfigRoutes } from "../../src/server/instance/config"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("config routes", () => {
  function app() {
    return new Hono().route("/config", ConfigRoutes())
  }

  test("reads config through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/config")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeObject()
      },
    })
  })

  test("lists configured providers through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/config/providers")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.providers).toBeArray()
        expect(body.default).toBeObject()
      },
    })
  })

  test("updates config through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "route-runtime-tester" }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ username: "route-runtime-tester" })

        const reread = await app().request("/config")
        expect(reread.status).toBe(200)
        expect(await reread.json()).toMatchObject({ username: "route-runtime-tester" })
      },
    })
  })
})
