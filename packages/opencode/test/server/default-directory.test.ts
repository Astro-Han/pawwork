import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "@opencode-ai/core/util/log"
import { Global } from "../../src/global"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("default directory routing", () => {
  test("uses ~/PawWork and creates it when no directory is provided", async () => {
    await using tmp = await tmpdir()
    const home = spyOn(os, "homedir").mockReturnValue(tmp.path)

    try {
      const app = Server.Default().app
      const response = await app.request("/path")
      const body = await response.json()
      const expected = path.join(tmp.path, "PawWork")

      expect(response.status).toBe(200)
      expect(body.directory).toBe(expected)
      expect(typeof body.worktree).toBe("string")
      expect(fs.existsSync(expected)).toBe(true)
    } finally {
      home.mockRestore()
    }
  })

  test("PawWork path route reports the primary global config Home without creating it", async () => {
    await using tmp = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousHome = process.env.OPENCODE_TEST_HOME
    const previousPawWorkHome = process.env.PAWWORK_HOME
    const previousConfig = Global.Path.config
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = tmp.path
    delete process.env.PAWWORK_HOME
    ;(Global.Path as { config: string }).config = path.join(tmp.path, "legacy-config")

    try {
      const app = Server.Default().app
      const response = await app.request("/path")
      const body = await response.json()
      const expected = path.join(tmp.path, ".pawwork")

      expect(response.status).toBe(200)
      expect(body.config).toBe(expected)
      expect(fs.existsSync(expected)).toBe(false)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
      if (previousPawWorkHome === undefined) delete process.env.PAWWORK_HOME
      else process.env.PAWWORK_HOME = previousPawWorkHome
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("PawWork path route creates the primary global config Home when explicitly requested", async () => {
    await using tmp = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousHome = process.env.OPENCODE_TEST_HOME
    const previousPawWorkHome = process.env.PAWWORK_HOME
    const previousConfig = Global.Path.config
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.OPENCODE_TEST_HOME = tmp.path
    delete process.env.PAWWORK_HOME
    ;(Global.Path as { config: string }).config = path.join(tmp.path, "legacy-config")

    try {
      const app = Server.Default().app
      const response = await app.request("/path?ensureConfig=true")
      const body = await response.json()
      const expected = path.join(tmp.path, ".pawwork")

      expect(response.status).toBe(200)
      expect(body.config).toBe(expected)
      expect(fs.existsSync(expected)).toBe(true)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
      if (previousPawWorkHome === undefined) delete process.env.PAWWORK_HOME
      else process.env.PAWWORK_HOME = previousPawWorkHome
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })
})
