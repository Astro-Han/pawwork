import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Hono } from "hono"
import { Config } from "../../src/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { GlobalRoutes } from "../../src/server/instance/global"
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
  test("gets and patches global config through the route runtime", async () => {
    await withConfigDepsLock(async () => {
      await withIsolatedGlobalConfig(async (globalDir) => {
        const app = new Hono().route("/global", GlobalRoutes())

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
})
