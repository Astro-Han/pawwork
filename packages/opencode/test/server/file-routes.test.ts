import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { FileRoutes } from "../../src/server/instance/file"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("file routes", () => {
  function app() {
    return new Hono().route("/", FileRoutes())
  }

  test("finds, lists, and reads files through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "sample.txt"), "hello\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const found = await app().request("/find/file?query=sample&dirs=false")
        expect(found.status).toBe(200)
        expect(await found.json()).toContain("sample.txt")

        const listed = await app().request("/file?path=.")
        expect(listed.status).toBe(200)
        expect((await listed.json()).map((item: { name: string }) => item.name)).toContain("sample.txt")

        const read = await app().request("/file/content?path=sample.txt")
        expect(read.status).toBe(200)
        expect(await read.json()).toMatchObject({ type: "text", content: "hello" })
      },
    })
  })

  test("returns file status through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/file/status")
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual([{ path: "tracked.txt", added: 1, removed: 1, status: "modified" }])
      },
    })
  })
})
