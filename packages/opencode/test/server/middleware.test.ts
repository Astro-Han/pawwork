import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { InvalidError, JsonError } from "../../src/config/error"
import { OauthCallbackFailed, OauthCodeMissing, OauthMissing } from "../../src/provider/auth"
import type { ProviderID } from "../../src/provider/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { WorkspaceRouterMiddleware } from "../../src/server/instance/middleware"
import { InstanceMiddleware } from "../../src/server/routes/instance/middleware"
import { currentRequestContext } from "../../src/server/request-context"
import { NotFoundError } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

type ErrorLogCall = {
  message?: unknown
  extra?: Record<string, unknown>
}

async function captureServerErrorLogs(fn: (calls: ErrorLogCall[]) => Promise<void>) {
  const logger = Log.create({ service: "server" })
  const original = logger.error
  const calls: ErrorLogCall[] = []

  logger.error = (message, extra) => {
    calls.push({ message, extra })
  }

  try {
    await fn(calls)
  } finally {
    logger.error = original
  }

  return calls
}

describe("server error middleware", () => {
  test("instance middleware records safe request context from headers", async () => {
    const app = new Hono()
    app.use(InstanceMiddleware())
    app.get("/context", (c) => c.json(currentRequestContext()))

    const response = await app.request("/context?directory=%2Ftmp%2Fpawwork-request-context", {
      headers: {
        "x-pawwork-client-action-id": "client-action-1",
        "x-pawwork-client-action-kind": "settings.provider.disconnect",
        "x-pawwork-route-session-id": "ses_route",
      },
    })
    const body = await response.json()

    expect(body).toMatchObject({
      method: "GET",
      path: "/context",
      source: "renderer",
      directory_key: expect.stringMatching(/^dir:/),
      client_action: {
        id: "client-action-1",
        kind: "settings.provider.disconnect",
        route_session_id: "ses_route",
      },
    })
    expect(JSON.stringify(body)).not.toContain("/tmp/pawwork-request-context")
  })

  test("instance middleware normalizes unsafe client action headers", async () => {
    const app = new Hono()
    app.use(InstanceMiddleware())
    app.get("/context", (c) => c.json(currentRequestContext()))

    const response = await app.request("/context?directory=%2Ftmp%2Fpawwork-request-context", {
      headers: {
        "x-pawwork-client-action-id": "client-action-unsafe",
        "x-pawwork-client-action-kind": "/Users/alice/project sk-secret",
      },
    })
    const body = await response.json()

    expect(body.client_action).toMatchObject({
      id: "client-action-unsafe",
      kind: "unknown",
    })
    expect(JSON.stringify(body)).not.toContain("/Users/alice")
    expect(JSON.stringify(body)).not.toContain("sk-secret")
  })

  test("workspace router records safe request context on main instance routes", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = new Hono()
    app.use(WorkspaceRouterMiddleware(() => undefined as never))
    app.get("/context", (c) => c.json(currentRequestContext()))

    const response = await app.request(`/context?directory=${encodeURIComponent(tmp.path)}`, {
      headers: {
        "x-pawwork-client-action-id": "client-action-main-route",
        "x-pawwork-client-action-kind": "project.git.init",
      },
    })
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body).toMatchObject({
      method: "GET",
      path: "/context",
      source: "renderer",
      directory_key: expect.stringMatching(/^dir:/),
      client_action: {
        id: "client-action-main-route",
        kind: "project.git.init",
      },
    })
    expect(JSON.stringify(body)).not.toContain("/tmp/pawwork-workspace-context")
    expect(JSON.stringify(body)).not.toContain(tmp.path)
  })

  test("serializes config named errors instead of wrapping them as unknown errors", async () => {
    const app = new Hono().get("/boom", () => {
      throw new JsonError({ path: "opencode.json", message: "bad json" })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.name).toBe("ConfigJsonError")
    expect(body.data.path).toBe("opencode.json")
    expect(body.data.message).toBe("bad json")
  })

  test("serializes config invalid errors with issues", async () => {
    const app = new Hono().get("/boom", () => {
      throw new InvalidError({
        path: "opencode.json",
        issues: [{ code: "custom", message: "bad field", path: ["server", "hostname"] }],
      })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.name).toBe("ConfigInvalidError")
    expect(body.data.path).toBe("opencode.json")
    expect(body.data.issues).toEqual([{ code: "custom", message: "bad field", path: ["server", "hostname"] }])
  })

  test("serializes config invalid errors without issues", async () => {
    const app = new Hono().get("/boom", () => {
      throw new InvalidError({
        path: "opencode.json",
        message: "bad config",
      })
    })
    app.onError(ErrorMiddleware)

    const response = await app.request("/boom")
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.name).toBe("ConfigInvalidError")
    expect(body.data.path).toBe("opencode.json")
    expect(body.data.message).toBe("bad config")
    expect(body.data.issues).toBeUndefined()
  })

  test("does not error-log expected not found responses", async () => {
    const app = new Hono().get("/missing", () => {
      throw new NotFoundError({ message: "Session not found: ses_missing" })
    })
    app.onError(ErrorMiddleware)

    let response!: Response
    let body!: { name: string }
    const calls = await captureServerErrorLogs(async () => {
      response = await app.request("/missing")
      body = await response.json()
    })

    expect(response.status).toBe(404)
    expect(body.name).toBe("NotFoundError")
    expect(calls).toEqual([])
  })

  test("still error-logs unexpected server failures", async () => {
    const error = new Error("boom")
    const app = new Hono().get("/boom", () => {
      throw error
    })
    app.onError(ErrorMiddleware)

    let response!: Response
    const calls = await captureServerErrorLogs(async () => {
      response = await app.request("/boom")
    })

    expect(response.status).toBe(500)
    expect(calls).toEqual([{ message: "failed", extra: { error } }])
  })

  test("maps provider oauth callback failures to 400 instead of 500", async () => {
    const providerID = "anthropic" as ProviderID
    const cases = [
      new OauthMissing({ providerID }),
      new OauthCodeMissing({ providerID }),
      new OauthCallbackFailed({}),
    ]

    for (const error of cases) {
      const app = new Hono().get("/boom", () => {
        throw error
      })
      app.onError(ErrorMiddleware)

      const response = await app.request("/boom")
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.name).toBe(error.name)
    }
  })
})
