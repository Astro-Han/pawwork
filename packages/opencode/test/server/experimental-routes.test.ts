import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem, NodeHttpPlatform, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Etag, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { ExperimentalRoutes } from "../../src/server/instance/experimental"
import { ErrorMiddleware } from "../../src/server/middleware"
import { ExperimentalApi } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { experimentalHandlers } from "../../src/server/routes/instance/httpapi/handlers/experimental"
import { Session } from "../../src/session"
import { Worktree } from "../../src/worktree"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const runSession = <A>(fn: (svc: Session.Interface) => Effect.Effect<A>) => AppRuntime.runPromise(Session.Service.use(fn))

afterEach(async () => {
  await Instance.disposeAll()
})

const worktreeMakeWorktreeInfo = (name?: string) =>
  Effect.runPromise(Worktree.Service.use((worktree) => worktree.makeWorktreeInfo(name)).pipe(Effect.provide(Worktree.defaultLayer)))
const worktreeCreateFromInfo = (info: Worktree.Info, startCommand?: string) =>
  Effect.runPromise(
    Worktree.Service.use((worktree) => worktree.createFromInfo(info, startCommand)).pipe(
      Effect.provide(Worktree.defaultLayer),
    ),
  )

describe("experimental routes", () => {
  function app() {
    return new Hono().route("/experimental", ExperimentalRoutes()).onError(ErrorMiddleware)
  }

  function requestExperimentalHttpApi(routePath: string, init?: RequestInit) {
    return AppRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(ExperimentalApi).pipe(
              Layer.provide(experimentalHandlers),
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

  test("declares the ordinary experimental route group as HttpApi endpoints", () => {
    const spec = OpenApi.fromApi(ExperimentalApi) as any

    for (const [routePath, method] of [
      ["/experimental/capabilities", "get"],
      ["/experimental/console", "get"],
      ["/experimental/console/orgs", "get"],
      ["/experimental/console/switch", "post"],
      ["/experimental/tool", "get"],
      ["/experimental/tool/ids", "get"],
      ["/experimental/resource", "get"],
      ["/experimental/worktree", "get"],
      ["/experimental/worktree", "post"],
      ["/experimental/worktree", "delete"],
      ["/experimental/worktree/reset", "post"],
    ] as const) {
      expect(spec.paths).toHaveProperty(routePath)
      expect(spec.paths[routePath]).toHaveProperty(method)
    }
  })

  test("lists tool IDs through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/tool/ids")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeArray()
      },
    })
  })

  test("lists console, tool, worktree, and resource data through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capabilities = await requestExperimentalHttpApi("/experimental/capabilities")
        expect(capabilities.status).toBe(200)
        expect(await capabilities.json()).toEqual({ backgroundSubagents: false })

        const consoleState = await requestExperimentalHttpApi("/experimental/console")
        expect(consoleState.status).toBe(200)
        expect(await consoleState.json()).toMatchObject({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        const orgs = await requestExperimentalHttpApi("/experimental/console/orgs")
        expect(orgs.status).toBe(200)
        expect(await orgs.json()).toEqual({ orgs: [] })

        const toolIDs = await requestExperimentalHttpApi("/experimental/tool/ids")
        expect(toolIDs.status).toBe(200)
        expect(await toolIDs.json()).toBeArray()

        const tools = await requestExperimentalHttpApi("/experimental/tool?provider=anthropic&model=claude")
        expect(tools.status).toBe(200)
        expect(await tools.json()).toBeArray()

        const worktrees = await requestExperimentalHttpApi("/experimental/worktree")
        expect(worktrees.status).toBe(200)
        expect(await worktrees.json()).toBeArray()

        const resources = await requestExperimentalHttpApi("/experimental/resource")
        expect(resources.status).toBe(200)
        expect(await resources.json()).toBeObject()
      },
    })
  })

  test("lists worktrees through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/worktree")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeArray()
      },
    })
  })

  test("lists MCP resources through the route runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/resource")
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toBeObject()
      },
    })
  })

  test("DELETE /worktree returns documented 400 when bound to an active session", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await worktreeMakeWorktreeInfo("bound-session")
        await worktreeCreateFromInfo(info)
        const session = await runSession((svc) => svc.create({ title: "Bound session" }))
        await runSession((svc) => svc.updateExecutionContext({ sessionID: session.id, activeWorktree: info }))
        return info
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await app().request("/experimental/worktree", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: info.directory }),
        })
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.name).toBe("WorktreeRemoveFailedError")
        expect(body.data.message).toContain("Worktree is in use by session")
      },
    })
  })

  test("DELETE /worktree keeps active session failures as bad requests through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const info = await worktreeMakeWorktreeInfo("bound-session-httpapi")
        await worktreeCreateFromInfo(info)
        const session = await runSession((svc) => svc.create({ title: "Bound session HttpApi" }))
        await runSession((svc) => svc.updateExecutionContext({ sessionID: session.id, activeWorktree: info }))
        return info
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestExperimentalHttpApi("/experimental/worktree", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: info.directory }),
        })
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.name).toBe("WorktreeRemoveFailedError")
        expect(body.data.message).toContain("Worktree is in use by session")
      },
    })
  })

  test("rejects malformed console switch JSON through the HttpApi handlers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await requestExperimentalHttpApi("/experimental/console/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })

        expect(response.status).toBe(400)
        expect(await response.text()).toBe("Malformed JSON in request body")
      },
    })
  })

  test("parses ?roots=false and ?archived=false as false instead of coercing them to true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await runSession((svc) => svc.create({ title: "roots-false-root" }))
        const child = await runSession((svc) => svc.create({ title: "roots-false-child", parentID: root.id }))
        const archived = await runSession((svc) => svc.create({ title: "archived-false" }))
        await runSession((svc) => svc.setArchived({ sessionID: archived.id, time: Date.now() }))

        // Scope listGlobal to this tmpdir so the default 100-row window can't push the
        // seeded sessions out when the in-memory DB holds other tests' sessions.
        const dir = encodeURIComponent(tmp.path)

        // z.coerce.boolean() coerced "false" to true, hiding child sessions; QueryBoolean
        // must parse ?roots=false as false so the roots filter stays disabled.
        const rootsRes = await app().request(`/experimental/session?roots=false&directory=${dir}`)
        expect(rootsRes.status).toBe(200)
        const rootsIds = (await rootsRes.json()).map((session: { id: string }) => session.id)
        expect(rootsIds).toContain(root.id)
        expect(rootsIds).toContain(child.id)

        // ?archived=false coerced to true would wrongly include archived sessions; it must
        // parse as false so the archived filter is applied.
        const archivedRes = await app().request(`/experimental/session?archived=false&directory=${dir}`)
        expect(archivedRes.status).toBe(200)
        const archivedIds = (await archivedRes.json()).map((session: { id: string }) => session.id)
        expect(archivedIds).toContain(root.id)
        expect(archivedIds).not.toContain(archived.id)
      },
    })
  })

  test("treats an empty session cursor as absent through the HttpApi handler", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "empty-cursor-httpapi" }))
        const dir = encodeURIComponent(tmp.path)

        const response = await requestExperimentalHttpApi(`/experimental/session?directory=${dir}&roots=true&limit=10&cursor=`)
        const ids = (await response.json()).map((item: { id: string }) => item.id)

        expect(response.status).toBe(200)
        expect(ids).toContain(session.id)
      },
    })
  })
})
