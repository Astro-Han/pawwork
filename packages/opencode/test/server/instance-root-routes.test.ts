import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("instance root routes", () => {
  test("returns path and metadata JSON through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const headers = { "x-opencode-directory": tmp.path }

    const pathResponse = await app.request("/path", { headers })
    expect(pathResponse.status).toBe(200)
    expect(await pathResponse.json()).toMatchObject({ directory: tmp.path, worktree: tmp.path })

    for (const route of ["/agent", "/skill", "/command", "/lsp"]) {
      const response = await app.request(route, { headers })
      expect(response.status, route).toBe(200)
      expect(await response.json(), route).toBeArray()
    }
  })

  test("returns VCS JSON through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const headers = { "x-opencode-directory": tmp.path }

    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")

    const info = await app.request("/vcs", { headers })
    expect(info.status).toBe(200)
    expect(await info.json()).toMatchObject({ branch: expect.any(String) })

    const diff = await app.request("/vcs/diff?mode=git", { headers })
    expect(diff.status).toBe(200)
    expect(await diff.json()).toEqual([
      expect.objectContaining({ file: "tracked.txt", additions: 1, deletions: 1, status: "modified" }),
    ])

    const status = await app.request("/vcs/status", { headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([{ file: "tracked.txt", additions: 1, deletions: 1, status: "modified" }])
  })

  test("disposes the current instance through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.Default().app.request("/instance/dispose", {
      method: "POST",
      headers: { "x-opencode-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
  })
})
