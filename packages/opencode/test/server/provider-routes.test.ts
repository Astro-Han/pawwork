import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Instance } from "../../src/project/instance"
import { ProviderRoutes } from "../../src/server/instance/provider"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("provider routes", () => {
  function app() {
    return new Hono().route("/provider", ProviderRoutes())
  }

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
      },
    })
  })
})
