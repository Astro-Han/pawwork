import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Hono } from "hono"
import path from "path"
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

  test("runs provider auth routes through the route runtime", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
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
      },
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
})
