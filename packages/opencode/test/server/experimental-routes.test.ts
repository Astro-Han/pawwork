import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Instance } from "../../src/project/instance"
import { ExperimentalRoutes } from "../../src/server/instance/experimental"
import { ErrorMiddleware } from "../../src/server/middleware"
import { Session } from "../../src/session"
import { Worktree } from "../../src/worktree"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("experimental routes", () => {
  function app() {
    return new Hono().route("/experimental", ExperimentalRoutes()).onError(ErrorMiddleware)
  }

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
        const info = await Worktree.makeWorktreeInfo("bound-session")
        await Worktree.createFromInfo(info)
        const session = await Session.create({ title: "Bound session" })
        await Session.updateExecutionContext({ sessionID: session.id, activeWorktree: info })
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

  test("parses ?roots=false and ?archived=false as false instead of coercing them to true", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const root = await Session.create({ title: "roots-false-root" })
        const child = await Session.create({ title: "roots-false-child", parentID: root.id })
        const archived = await Session.create({ title: "archived-false" })
        await Session.setArchived({ sessionID: archived.id, time: Date.now() })

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
})
