import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { GlobalApi } from "../../src/server/routes/instance/httpapi/groups/global"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { tmpdir } from "../fixture/fixture"
import { withConfigDepsLock } from "../shared/config-deps-lock"

afterEach(async () => {
  await Instance.disposeAll()
})

async function invalidateConfig() {
  await AppRuntime.runPromise(Config.Service.use((svc) => svc.invalidate(true)))
}

async function withIsolatedGlobalConfig<T>(fn: (globalDir: string) => Promise<T>) {
  await using global = await tmpdir()
  const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
  const previousHome = process.env.PAWWORK_HOME
  const previousConfigDir = process.env.PAWWORK_CONFIG_DIR
  const previousConfig = Global.Path.config

  process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
  process.env.PAWWORK_HOME = global.path
  delete process.env.PAWWORK_CONFIG_DIR
  ;(Global.Path as { config: string }).config = global.path
  await invalidateConfig()

  try {
    return await fn(global.path)
  } finally {
    ;(Global.Path as { config: string }).config = previousConfig
    if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
    else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    if (previousHome === undefined) delete process.env.PAWWORK_HOME
    else process.env.PAWWORK_HOME = previousHome
    if (previousConfigDir === undefined) delete process.env.PAWWORK_CONFIG_DIR
    else process.env.PAWWORK_CONFIG_DIR = previousConfigDir
    await invalidateConfig()
  }
}

describe("global config routes", () => {
  function requestGlobalHttpApi(routePath: string, init?: RequestInit, serviceLayer = Layer.empty) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(GlobalApi).pipe(
              Layer.provide(globalHandlers),
              Layer.provide(
                Layer.mergeAll(serviceLayer, NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer),
              ),
            ),
          )
          const request = HttpServerRequest.fromWeb(new Request(`http://localhost${routePath}`, init))
          const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
          return HttpServerResponse.toWeb(response)
        }),
      ) as Effect.Effect<Response>,
    )
  }

  test("declares global HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(GlobalApi) as any

    expect(spec.paths["/global/config"]).toHaveProperty("get")
    expect(spec.paths["/global/config"]).toHaveProperty("patch")
    expect(spec.paths["/global/config/mcp"]).toHaveProperty("get")
    expect(spec.paths["/global/config/mcp"]).toHaveProperty("post")
    expect(spec.paths["/global/config/mcp/repair"]).toHaveProperty("post")
    expect(spec.paths["/global/health"]).toHaveProperty("get")
    expect(spec.paths["/global/dispose"]).toHaveProperty("post")
    expect(spec.paths["/global/upgrade"]).toHaveProperty("post")
  })

  test("gets and patches global config through the production app", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        const app = Server.Default().app

        const before = await app.request("/global/config")
        expect(before.status).toBe(200)

        const response = await app.request("/global/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "test/model" }),
        })
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.model).toBe("test/model")
        expect(JSON.parse(await fs.readFile(path.join(globalDir, "pawwork.json"), "utf8")).model).toBe("test/model")
      })
    })
  })

  test("reports invalid MCP entries without hiding valid neighbors", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        await fs.writeFile(
          path.join(globalDir, "pawwork.json"),
          JSON.stringify({
            username: "kept-user",
            mcp: {
              working: { type: "remote", url: "https://working.example/mcp" },
              broken: null,
            },
          }),
          "utf8",
        )

        const response = await Server.Default().app.request("/global/config/mcp")

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
          mcp: { working: { type: "remote", url: "https://working.example/mcp" } },
          invalid: ["broken"],
          invalidRoot: false,
        })
      })
    })
  })

  test("reports an invalid MCP root separately from server names", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        await fs.writeFile(path.join(globalDir, "pawwork.json"), JSON.stringify({ mcp: null }), "utf8")

        const response = await Server.Default().app.request("/global/config/mcp")

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ mcp: {}, invalid: [], invalidRoot: true })
      })
    })
  })

  test("reports an empty object as an invalid MCP entry", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        await fs.writeFile(path.join(globalDir, "pawwork.json"), JSON.stringify({ mcp: { broken: {} } }), "utf8")

        const response = await Server.Default().app.request("/global/config/mcp")

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ mcp: {}, invalid: ["broken"], invalidRoot: false })
      })
    })
  })

  test("backs up the config before repairing only invalid MCP entries", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        const file = path.join(globalDir, "pawwork.jsonc")
        const original =
          '{\n  // keep this comment\n  "username": "kept-user",\n  "mcp": {\n    "working": { "type": "remote", "url": "https://working.example/mcp" },\n    "broken": null\n  }\n}\n'
        await fs.writeFile(file, original, "utf8")

        const response = await Server.Default().app.request("/global/config/mcp/repair", { method: "POST" })
        const result = (await response.json()) as { changed: boolean; repaired: string[]; backups: string[] }

        expect(response.status).toBe(200)
        expect(result.changed).toBe(true)
        expect(result.repaired).toEqual(["broken"])
        expect(result.backups).toHaveLength(1)
        expect(path.dirname(result.backups[0]!)).toBe(globalDir)
        expect(path.basename(result.backups[0]!)).toMatch(/^pawwork\.jsonc\.backup-\d{8}-\d{9}$/)
        expect(await fs.readFile(result.backups[0]!, "utf8")).toBe(original)

        const repaired = await fs.readFile(file, "utf8")
        expect(repaired).toContain("// keep this comment")
        expect(repaired).toContain('"username": "kept-user"')
        expect(repaired).toContain('"working"')
        expect(repaired).not.toContain('"broken"')
      })
    })
  })

  test("repairs an invalid server named $mcp without deleting valid neighbors", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        const file = path.join(globalDir, "pawwork.jsonc")
        await fs.writeFile(
          file,
          JSON.stringify({
            mcp: {
              working: { type: "remote", url: "https://working.example/mcp" },
              $mcp: null,
            },
          }),
          "utf8",
        )

        const response = await Server.Default().app.request("/global/config/mcp/repair", { method: "POST" })
        const result = (await response.json()) as { repaired: string[] }
        const repaired = JSON.parse(await fs.readFile(file, "utf8")) as { mcp?: Record<string, unknown> }

        expect(response.status).toBe(200)
        expect(result.repaired).toEqual(["$mcp"])
        expect(repaired.mcp).toEqual({
          working: { type: "remote", url: "https://working.example/mcp" },
        })
      })
    })
  })

  test("serves config and health through the HttpApi handlers", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        const before = await requestGlobalHttpApi("/global/config")
        expect(before.status).toBe(200)

        const response = await requestGlobalHttpApi("/global/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "test/httpapi-global-model" }),
        })
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.model).toBe("test/httpapi-global-model")
        expect(JSON.parse(await fs.readFile(path.join(globalDir, "pawwork.json"), "utf8")).model).toBe(
          "test/httpapi-global-model",
        )

        const health = await requestGlobalHttpApi("/global/health")
        expect(health.status).toBe(200)
        expect(await health.json()).toMatchObject({ healthy: true, version: expect.any(String) })
      })
    })
  })

  test("returns the merged global config after HttpApi patch", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        await fs.writeFile(path.join(globalDir, "pawwork.json"), JSON.stringify({ username: "kept-user" }), "utf8")

        const response = await requestGlobalHttpApi("/global/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "test/httpapi-merged-model" }),
        })
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toMatchObject({
          username: "kept-user",
          model: "test/httpapi-merged-model",
        })
      })
    })
  })

  test("serves dispose and upgrade through the HttpApi handlers", async () => {
    const dispose = await requestGlobalHttpApi("/global/dispose", { method: "POST" })
    expect(dispose.status).toBe(200)
    expect(await dispose.json()).toMatchObject({
      status: expect.stringMatching(/^(completed|deferred)$/),
      lifecycleActionID: expect.any(String),
      affectedDirectoryKeys: expect.any(Array),
    })

    const installation = Layer.succeed(Installation.Service, {
      info: () => Effect.succeed({ version: "0.0.0", latest: "9.9.9" }),
      method: () => Effect.succeed("npm" as const),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    } satisfies Installation.Interface)

    const upgraded = await requestGlobalHttpApi(
      "/global/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "9.9.9" }),
      },
      installation,
    )
    expect(upgraded.status).toBe(200)
    expect(await upgraded.json()).toEqual({ success: true, version: "9.9.9" })

    const unknownInstallation = Layer.succeed(Installation.Service, {
      info: () => Effect.succeed({ version: "0.0.0", latest: "9.9.9" }),
      method: () => Effect.succeed("unknown" as const),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    } satisfies Installation.Interface)

    const rejected = await requestGlobalHttpApi(
      "/global/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "9.9.9" }),
      },
      unknownInstallation,
    )
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ success: false, error: "Unknown installation method" })
  })
})
