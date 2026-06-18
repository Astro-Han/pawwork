import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { MemoryRoutes } from "../../src/server/instance/memory"
import { MemoryApi } from "../../src/server/routes/instance/httpapi/groups/memory"
import { memoryHandlers } from "../../src/server/routes/instance/httpapi/handlers/memory"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const originalPawWorkHome = process.env.PAWWORK_HOME

afterEach(async () => {
  if (originalPawWorkHome === undefined) delete process.env.PAWWORK_HOME
  else process.env.PAWWORK_HOME = originalPawWorkHome
  await Instance.disposeAll()
})

describe("memory routes", () => {
  function app() {
    return new Hono().route("/memory", MemoryRoutes())
  }

  function requestMemoryHttpApi(routePath: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(MemoryApi).pipe(
              Layer.provide(memoryHandlers),
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

  test("declares the memory route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(MemoryApi) as any

    expect(spec.paths["/memory"]).toHaveProperty("get")
    expect(spec.paths["/memory"]).toHaveProperty("patch")
    expect(spec.paths["/memory/reset"]).toHaveProperty("post")
    expect(spec.paths["/memory/disabled"]).toHaveProperty("patch")
    expect(spec.paths["/memory/entry/{id}"]).toHaveProperty("delete")
    expect(spec.paths["/memory"]?.patch?.responses?.["400"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            anyOf: [
              { $ref: "#/components/schemas/BadRequestError" },
              { $ref: "#/components/schemas/InvalidMemoryFileError" },
            ],
          },
        },
      },
    })
  })

  test("reads and updates memory through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initial = await app().request("/memory")
        expect(initial.status).toBe(200)
        expect(await initial.json()).toMatchObject({ disabled: false, status: "ok" })

        const content = "# PawWork Memory\n\n## Profile\n\n- PawWork Memory is enabled.\n\n## Archive\n\n### First id:first\n\nStored note.\n"
        const updated = await app().request("/memory", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        })
        expect(updated.status).toBe(200)
        expect(await updated.json()).toMatchObject({ content })

        const disabled = await app().request("/memory/disabled", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: true }),
        })
        expect(disabled.status).toBe(200)
        expect(await disabled.json()).toMatchObject({ disabled: true })

        const deleted = await app().request("/memory/entry/first", { method: "DELETE" })
        expect(deleted.status).toBe(200)
        expect((await deleted.json()).content).not.toContain("Stored note.")
      },
    })
  })

  test("PATCH with invalid content returns a clean safe-mode reason", async () => {
    await using tmp = await tmpdir({ git: true })
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/memory", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "garbage with no profile or archive sections" }),
        })

        expect(response.status).toBe(400)
        const body = await response.json()
        // The original error must surface cleanly through the Effect runtime,
        // not as a wrapped FiberFailure trace.
        expect(body).toMatchObject({ error: "invalid_memory_file", reason: "missing_profile" })
      },
    })
  })

  test("reads, updates, disables, deletes, and rejects invalid content through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const initial = await requestMemoryHttpApi("/memory")
        expect(initial.status).toBe(200)
        expect(await initial.json()).toMatchObject({ disabled: false, status: "ok" })

        const content = "# PawWork Memory\n\n## Profile\n\n- PawWork Memory is enabled.\n\n## Archive\n\n### First id:first\n\nStored note.\n"
        const updated = await requestMemoryHttpApi("/memory", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        })
        expect(updated.status).toBe(200)
        expect(await updated.json()).toMatchObject({ content })

        const disabled = await requestMemoryHttpApi("/memory/disabled", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: true }),
        })
        expect(disabled.status).toBe(200)
        expect(await disabled.json()).toMatchObject({ disabled: true })

        const deleted = await requestMemoryHttpApi("/memory/entry/first", { method: "DELETE" })
        expect(deleted.status).toBe(200)
        expect((await deleted.json()).content).not.toContain("Stored note.")

        const reset = await requestMemoryHttpApi("/memory/reset", { method: "POST" })
        expect(reset.status).toBe(200)
        expect(await reset.json()).toMatchObject({ content: expect.stringContaining("## Profile"), status: "ok" })

        const invalid = await requestMemoryHttpApi("/memory", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "garbage with no profile or archive sections" }),
        })
        expect(invalid.status).toBe(400)
        expect(await invalid.json()).toMatchObject({ error: "invalid_memory_file", reason: "missing_profile" })
      },
    })
  })
})
