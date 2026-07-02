import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import path from "path"
import { GlobalBus } from "../../src/bus/global"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Snapshot } from "../../src/snapshot"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { ProjectApi } from "../../src/server/routes/instance/httpapi/groups/project"
import { projectHandlers } from "../../src/server/routes/instance/httpapi/handlers/project"
import { Filesystem } from "../../src/util/filesystem"
import { Log } from "../../src/util"
import { resetDatabase } from "../fixture/db"
import { provideInstance, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("project.initGit endpoint", () => {
  function requestProjectHttpApi(routePath: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(ProjectApi).pipe(
              Layer.provide(projectHandlers),
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

  test("lists and reads projects through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const headers = { "x-opencode-directory": tmp.path }
        const list = await app.request("/project", { headers })
        expect(list.status).toBe(200)
        expect(await list.json()).toBeArray()

        const current = await app.request("/project/current", { headers })
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({ vcs: "git", worktree: tmp.path })
      },
    })
  })

  test("initializes git and reloads immediately", async () => {
    await using tmp = await tmpdir()
    const app = Server.Default().app
    const seen: { directory?: string; payload: { type: string } }[] = []
    const fn = (evt: { directory?: string; payload: { type: string } }) => {
      seen.push(evt)
    }
    const reload = Instance.reload
    const reloadSpy = spyOn(Instance, "reload").mockImplementation((input) => reload(input))
    GlobalBus.on("event", fn)

    try {
      const init = await app.request("/project/git/init", {
        method: "POST",
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      const body = await init.json()
      expect(init.status).toBe(200)
      expect(body).toMatchObject({
        id: "global",
        vcs: "git",
        worktree: tmp.path,
      })
      expect(reloadSpy).toHaveBeenCalledTimes(1)
      expect(seen.some((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed")).toBe(
        true,
      )
      expect(await Filesystem.exists(path.join(tmp.path, ".git", "opencode"))).toBe(false)

      const current = await app.request("/project/current", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({
        id: "global",
        vcs: "git",
        worktree: tmp.path,
      })

      expect(
        await Effect.runPromise(
          Snapshot.Service.use((svc) => svc.track()).pipe(
            provideInstance(tmp.path),
            Effect.provide(Snapshot.defaultLayer),
          ),
        ),
      ).toBeTruthy()
    } finally {
      await Instance.disposeAll()
      reloadSpy.mockRestore()
      GlobalBus.off("event", fn)
    }
  })

  test("initializes git through the HttpApi handlers", async () => {
    await using tmp = await tmpdir()
    const seen: { directory?: string; payload: { type: string } }[] = []
    const fn = (evt: { directory?: string; payload: { type: string } }) => {
      seen.push(evt)
    }
    const reload = Instance.reload
    const reloadSpy = spyOn(Instance, "reload").mockImplementation((input) => reload(input))
    GlobalBus.on("event", fn)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const init = await requestProjectHttpApi("/project/git/init", { method: "POST" })
          const body = await init.json()

          expect(init.status).toBe(200)
          expect(body).toMatchObject({
            id: "global",
            vcs: "git",
            worktree: tmp.path,
          })
          expect(reloadSpy).toHaveBeenCalledTimes(1)
          expect(seen.some((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed")).toBe(
            true,
          )
          expect(await Filesystem.exists(path.join(tmp.path, ".git", "opencode"))).toBe(false)
        },
      })
    } finally {
      await Instance.disposeAll()
      reloadSpy.mockRestore()
      GlobalBus.off("event", fn)
    }
  })

  test("does not reload when the project is already git", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const seen: { directory?: string; payload: { type: string } }[] = []
    const fn = (evt: { directory?: string; payload: { type: string } }) => {
      seen.push(evt)
    }
    const reload = Instance.reload
    const reloadSpy = spyOn(Instance, "reload").mockImplementation((input) => reload(input))
    GlobalBus.on("event", fn)

    try {
      const init = await app.request("/project/git/init", {
        method: "POST",
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      expect(init.status).toBe(200)
      expect(await init.json()).toMatchObject({
        vcs: "git",
        worktree: tmp.path,
      })
      expect(
        seen.filter((evt) => evt.directory === tmp.path && evt.payload.type === "server.instance.disposed").length,
      ).toBe(0)
      expect(reloadSpy).toHaveBeenCalledTimes(0)

      const current = await app.request("/project/current", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      expect(current.status).toBe(200)
      expect(await current.json()).toMatchObject({
        vcs: "git",
        worktree: tmp.path,
      })
    } finally {
      await Instance.disposeAll()
      reloadSpy.mockRestore()
      GlobalBus.off("event", fn)
    }
  })
})
