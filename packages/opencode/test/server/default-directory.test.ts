import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "@opencode-ai/core/util/log"
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
})
