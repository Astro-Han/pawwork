import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import fs from "fs/promises"
import path from "path"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { FileApi } from "../../src/server/routes/instance/httpapi/groups/file"
import { fileHandlers } from "../../src/server/routes/instance/httpapi/handlers/file"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("file routes", () => {
  function requestFileHttpApi(routePath: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(FileApi).pipe(
              Layer.provide(fileHandlers),
              Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
            ),
          )
          const request = HttpServerRequest.fromWeb(new Request(`http://localhost${routePath}`, init))
          const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
          return HttpServerResponse.toWeb(response)
        }),
      ) as Effect.Effect<Response>,
    )
  }

  test("declares the file route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(FileApi) as any

    for (const [routePath, method] of [
      ["/find", "get"],
      ["/find/file", "get"],
      ["/find/symbol", "get"],
      ["/file", "get"],
      ["/file/content", "get"],
      ["/file/status", "get"],
    ] as const) {
      expect(spec.paths).toHaveProperty(routePath)
      expect(spec.paths[routePath]).toHaveProperty(method)
    }
  })

  test("finds, lists, reads, and reports status through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "sample.txt"), "hello\n", "utf-8")
    await $`git add sample.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "sample.txt"), "hello changed\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const text = await requestFileHttpApi("/find?pattern=hello")
        expect(text.status).toBe(200)
        expect(await text.json()).toMatchObject({ partial: false })

        const found = await requestFileHttpApi("/find/file?query=sample&dirs=false")
        expect(found.status).toBe(200)
        expect(await found.json()).toContain("sample.txt")

        const symbols = await requestFileHttpApi("/find/symbol?query=sample")
        expect(symbols.status).toBe(200)
        expect(await symbols.json()).toEqual([])

        const listed = await requestFileHttpApi("/file?path=.")
        expect(listed.status).toBe(200)
        expect((await listed.json()).map((item: { name: string }) => item.name)).toContain("sample.txt")

        const read = await requestFileHttpApi("/file/content?path=sample.txt")
        expect(read.status).toBe(200)
        expect(await read.json()).toMatchObject({ type: "text", content: "hello changed" })

        const status = await requestFileHttpApi("/file/status")
        expect(status.status).toBe(200)
        expect(await status.json()).toEqual([{ path: "sample.txt", added: 1, removed: 1, status: "modified" }])
      },
    })
  })
})
