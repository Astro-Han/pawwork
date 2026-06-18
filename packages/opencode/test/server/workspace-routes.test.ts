import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import path from "path"
import { pathToFileURL } from "url"
import { Log } from "@opencode-ai/core/util/log"
import { Workspace } from "../../src/control-plane/workspace"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { ErrorMiddleware } from "../../src/server/middleware"
import { WorkspaceRoutes } from "../../src/server/instance/workspace"
import { WorkspaceApi } from "../../src/server/routes/instance/httpapi/groups/workspace"
import { workspaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/workspace"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

afterAll(() => {
  if (disableDefault === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

function app() {
  return new Hono().onError(ErrorMiddleware).route("/workspace", WorkspaceRoutes())
}

function requestWorkspaceHttpApi(path: string, init?: RequestInit) {
  return AppRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* HttpRouter.toHttpEffect(
          HttpApiBuilder.layer(WorkspaceApi).pipe(
            Layer.provide(workspaceHandlers),
            Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeHttpPlatform.layer, NodePath.layer, Etag.layer)),
          ),
        )
        const request = HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, init))
        const response = yield* router.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request), Effect.orDie)
        return HttpServerResponse.toWeb(response)
      }),
    ) as Effect.Effect<Response>,
  )
}

async function workspaceProject(label: string) {
  return tmpdir({
    git: true,
    init: async (dir) => {
      const type = `route-${label}-${Math.random().toString(36).slice(2)}`
      const file = path.join(dir, "plugin.ts")
      await Bun.write(
        file,
        [
          "export default async ({ experimental_workspace }) => {",
          `  experimental_workspace.register(${JSON.stringify(type)}, {`,
          `    name: ${JSON.stringify(label)},`,
          `    description: ${JSON.stringify(`${label} workspace adaptor`)},`,
          "    configure(input) {",
          `      return { ...input, name: ${JSON.stringify(label)}, branch: "route/main", directory: ${JSON.stringify(dir)} }`,
          "    },",
          "    async create() {},",
          "    async remove() {},",
          '    target(input) { return { type: "local", directory: input.directory } }',
          "  })",
          "  return {}",
          "}",
          "",
        ].join("\n"),
      )

      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
          },
          null,
          2,
        ),
      )

      return { type }
    },
  })
}

async function createWorkspace(type: string) {
  return app().request("/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type,
      branch: null,
      extra: null,
    }),
  })
}

async function createWorkspaceHttpApi(type: string) {
  return requestWorkspaceHttpApi("/experimental/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type,
      branch: null,
      extra: null,
    }),
  })
}

async function waitForStatus(workspaceID: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = Workspace.status()
    if (status.some((item) => item.workspaceID === workspaceID)) return status
    await Bun.sleep(25)
  }
  throw new Error(`Workspace status not observed for ${workspaceID}`)
}

describe("workspace routes", () => {
  test("declares the experimental workspace route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(WorkspaceApi) as any

    expect(spec.paths).toHaveProperty("/experimental/workspace")
    expect(spec.paths).toHaveProperty("/experimental/workspace/status")
    expect(spec.paths).toHaveProperty("/experimental/workspace/{id}")
    expect(spec.paths["/experimental/workspace"]).toHaveProperty("post")
    expect(spec.paths["/experimental/workspace"]).toHaveProperty("get")
    expect(spec.paths["/experimental/workspace/status"]).toHaveProperty("get")
    expect(spec.paths["/experimental/workspace/{id}"]).toHaveProperty("delete")
  })

  test("creates, lists, reports status, and removes workspaces through the route runtime", async () => {
    await using current = await workspaceProject("current")
    await using other = await workspaceProject("other")

    let otherWorkspace: Workspace.Info | undefined
    await Instance.provide({
      directory: other.path,
      fn: async () => {
        await Plugin.init()
        const response = await createWorkspace(other.extra.type)
        expect(response.status).toBe(200)
        otherWorkspace = await response.json()
        await waitForStatus(otherWorkspace!.id)
      },
    })

    await Instance.provide({
      directory: current.path,
      fn: async () => {
        await Plugin.init()

        const createdResponse = await createWorkspace(current.extra.type)
        expect(createdResponse.status).toBe(200)
        const created = (await createdResponse.json()) as Workspace.Info
        expect(created).toMatchObject({
          type: current.extra.type,
          name: "current",
          branch: "route/main",
          directory: current.path,
          projectID: Instance.project.id,
        })

        const listResponse = await app().request("/workspace")
        expect(listResponse.status).toBe(200)
        expect(await listResponse.json()).toEqual([created])

        await waitForStatus(created.id)
        const statusResponse = await app().request("/workspace/status")
        expect(statusResponse.status).toBe(200)
        const status = (await statusResponse.json()) as Workspace.ConnectionStatus[]
        expect(status.map((item) => item.workspaceID)).toContain(created.id)
        expect(status.map((item) => item.workspaceID)).not.toContain(otherWorkspace!.id)

        const deleteResponse = await app().request(`/workspace/${created.id}`, { method: "DELETE" })
        expect(deleteResponse.status).toBe(200)
        expect(await deleteResponse.json()).toEqual(created)

        const listAfterDelete = await app().request("/workspace")
        expect(listAfterDelete.status).toBe(200)
        expect(await listAfterDelete.json()).toEqual([])
      },
    })

    await Instance.provide({
      directory: other.path,
      fn: async () => {
        await Plugin.init()
        const response = await app().request(`/workspace/${otherWorkspace!.id}`, { method: "DELETE" })
        expect(response.status).toBe(200)
      },
    })
  })

  test("creates, lists, reports status, and removes workspaces through the HttpApi handlers", async () => {
    await using current = await workspaceProject("current-httpapi")

    await Instance.provide({
      directory: current.path,
      fn: async () => {
        await Plugin.init()

        const createdResponse = await createWorkspaceHttpApi(current.extra.type)
        expect(createdResponse.status).toBe(200)
        const created = (await createdResponse.json()) as Workspace.Info
        expect(created).toMatchObject({
          type: current.extra.type,
          name: "current-httpapi",
          branch: "route/main",
          directory: current.path,
          projectID: Instance.project.id,
        })

        const listResponse = await requestWorkspaceHttpApi("/experimental/workspace")
        expect(listResponse.status).toBe(200)
        expect(await listResponse.json()).toEqual([created])

        await waitForStatus(created.id)
        const statusResponse = await requestWorkspaceHttpApi("/experimental/workspace/status")
        expect(statusResponse.status).toBe(200)
        const status = (await statusResponse.json()) as Workspace.ConnectionStatus[]
        expect(status.map((item) => item.workspaceID)).toContain(created.id)

        const deleteResponse = await requestWorkspaceHttpApi(`/experimental/workspace/${created.id}`, { method: "DELETE" })
        expect(deleteResponse.status).toBe(200)
        expect(await deleteResponse.json()).toEqual(created)
      },
    })
  })

  test("keeps worktree create failures as bad requests", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await createWorkspace("worktree")
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          name: "WorktreeNotGitError",
          data: {
            message: "Worktrees are only supported for git projects",
          },
        })
      },
    })
  })

  test("keeps worktree create failures as bad requests through the HttpApi handlers", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await createWorkspaceHttpApi("worktree")
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          name: "WorktreeNotGitError",
          data: {
            message: "Worktrees are only supported for git projects",
          },
        })
      },
    })
  })
})
