import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ProjectRoutes } from "../../src/server/instance/project"
import { ProjectApi } from "../../src/server/routes/instance/httpapi/groups/project"
import { projectHandlers } from "../../src/server/routes/instance/httpapi/handlers/project"
import { ErrorMiddleware } from "../../src/server/middleware"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("project routes", () => {
  function app() {
    return new Hono().route("/project", ProjectRoutes()).onError(ErrorMiddleware)
  }

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

  test("declares the project route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(ProjectApi) as any

    expect(spec.paths["/project"]).toHaveProperty("get")
    expect(spec.paths["/project/current"]).toHaveProperty("get")
    expect(spec.paths["/project/git/init"]).toHaveProperty("post")
    expect(spec.paths["/project/{projectID}"]).toHaveProperty("patch")
    expect(spec.paths["/project/{projectID}"]?.patch?.responses?.["404"]).toMatchObject({
      description: "Not found",
      content: { "application/json": { schema: { $ref: "#/components/schemas/NotFoundError" } } },
    })
  })

  test("PATCH /:projectID returns documented 404 when the project does not exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/project/nonexistent-project-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Should Fail" }),
        })
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.name).toBe("NotFoundError")
        expect(body.data.message).toContain("Project not found: nonexistent-project-id")
      },
    })
  })

  test("serves list, current, and PATCH 404 through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const list = await requestProjectHttpApi("/project")
        expect(list.status).toBe(200)
        expect(await list.json()).toBeArray()

        const current = await requestProjectHttpApi("/project/current")
        expect(current.status).toBe(200)
        expect(await current.json()).toMatchObject({ vcs: "git", worktree: tmp.path })

        const missing = await requestProjectHttpApi("/project/nonexistent-project-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Should Fail" }),
        })
        const body = await missing.json()

        expect(missing.status).toBe(404)
        expect(body.name).toBe("NotFoundError")
        expect(body.data.message).toContain("Project not found: nonexistent-project-id")
      },
    })
  })
})
