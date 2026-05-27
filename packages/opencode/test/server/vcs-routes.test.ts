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

describe("VCS routes", () => {
  test("returns working tree status summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")
    await fs.writeFile(path.join(tmp.path, "untracked.txt"), "new\n", "utf-8")

    const response = await Server.Default().app.request("/vcs/status", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { file: "tracked.txt", additions: 1, deletions: 1, status: "modified" },
      { file: "untracked.txt", additions: 1, deletions: 0, status: "added" },
    ])
  })

  test("returns raw patch text", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")

    const response = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(await response.text()).toContain("diff --git a/tracked.txt b/tracked.txt")
  })

  test("applies a patch and reports apply failures", async () => {
    await using source = await tmpdir({ git: true })
    await fs.writeFile(path.join(source.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(source.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(source.path).quiet()
    await fs.writeFile(path.join(source.path, "tracked.txt"), "changed\n", "utf-8")
    const sourcePatch = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": source.path,
      },
    })
    const patch = await sourcePatch.text()

    await using target = await tmpdir({ git: true })
    await fs.writeFile(path.join(target.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(target.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(target.path).quiet()

    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    expect(await applied.json()).toEqual({ applied: true })
    await expect(fs.readFile(path.join(target.path, "tracked.txt"), "utf-8")).resolves.toBe("changed\n")

    const failed = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({
      error: "vcs_apply_failed",
      reason: "not-clean",
    })
  })
})
