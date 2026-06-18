import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { RootApi } from "../../src/server/routes/instance/httpapi/groups/root"
import { rootHandlers } from "../../src/server/routes/instance/httpapi/handlers/root"
import { AppRuntime } from "../../src/effect/app-runtime"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("instance root routes", () => {
  function requestRootHttpApi(routePath: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(RootApi).pipe(
              Layer.provide(rootHandlers),
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

  test("declares root instance HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(RootApi) as any

    for (const [routePath, method] of [
      ["/instance/dispose", "post"],
      ["/path", "get"],
      ["/vcs", "get"],
      ["/vcs/status", "get"],
      ["/vcs/diff", "get"],
      ["/vcs/diff/raw", "get"],
      ["/vcs/apply", "post"],
      ["/command", "get"],
      ["/agent", "get"],
      ["/skill", "get"],
      ["/lsp", "get"],
    ] as const) {
      expect(spec.paths).toHaveProperty(routePath)
      expect(spec.paths[routePath]).toHaveProperty(method)
    }
  })

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

  test("serves path, metadata, VCS, and dispose through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pathResponse = await requestRootHttpApi("/path")
        expect(pathResponse.status).toBe(200)
        expect(await pathResponse.json()).toMatchObject({ directory: tmp.path, worktree: tmp.path })

        for (const route of ["/agent", "/skill", "/command", "/lsp"]) {
          const response = await requestRootHttpApi(route)
          expect(response.status, route).toBe(200)
          expect(await response.json(), route).toBeArray()
        }

        const info = await requestRootHttpApi("/vcs")
        expect(info.status).toBe(200)
        expect(await info.json()).toMatchObject({ branch: expect.any(String) })

        const diff = await requestRootHttpApi("/vcs/diff?mode=git")
        expect(diff.status).toBe(200)
        expect(await diff.json()).toEqual([
          expect.objectContaining({ file: "tracked.txt", additions: 1, deletions: 1, status: "modified" }),
        ])

        const status = await requestRootHttpApi("/vcs/status")
        expect(status.status).toBe(200)
        expect(await status.json()).toEqual([{ file: "tracked.txt", additions: 1, deletions: 1, status: "modified" }])

        const dispose = await requestRootHttpApi("/instance/dispose", { method: "POST" })
        expect(dispose.status).toBe(200)
        expect(await dispose.json()).toBe(true)
      },
    })
  })

  test("preserves VCS apply validation through the HttpApi handlers", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        for (const item of [
          { name: "missing patch", body: JSON.stringify({}) },
          { name: "non-string patch", body: JSON.stringify({ patch: 1 }) },
          { name: "invalid JSON", body: "{" },
          { name: "empty JSON body", body: undefined },
        ]) {
          const response = await requestRootHttpApi("/vcs/apply", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: item.body,
          })

          expect(response.status, item.name).toBe(400)
          expect(await response.json(), item.name).toEqual({
            error: "vcs_apply_failed",
            reason: "invalid-input",
            message: "Patch request body must be valid JSON with a string patch",
          })
        }

        const maxEncodedBodyBytes = 10_000_000 * 6 + Buffer.byteLength(JSON.stringify({ patch: "" }))
        const tooLarge = await requestRootHttpApi("/vcs/apply", {
          method: "POST",
          headers: {
            "content-length": String(maxEncodedBodyBytes + 1),
            "content-type": "application/json",
          },
          body: JSON.stringify({ patch: "" }),
        })

        expect(tooLarge.status).toBe(413)
        expect(await tooLarge.json()).toEqual({
          error: "vcs_apply_failed",
          reason: "too-large",
          message: "Patch exceeds the 10 MB input limit",
        })
      },
    })
  })
})
