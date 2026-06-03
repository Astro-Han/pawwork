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
})
