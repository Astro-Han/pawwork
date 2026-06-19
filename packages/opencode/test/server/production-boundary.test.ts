import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { PtyID } from "../../src/pty/schema"
import { PtyTicket } from "../../src/pty/ticket"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

describe("production server boundary", () => {
  async function readFirstChunk(response: Response) {
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected response body")
    try {
      const first = await reader.read()
      return new TextDecoder().decode(first.value)
    } finally {
      await reader.cancel()
    }
  }

  test("serves ordinary JSON API requests through the production app", async () => {
    const response = await Server.Default().app.request("/global/health")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({ healthy: true, version: "local" })
  })

  test("serves the OpenAPI document through the production API path", async () => {
    const response = await Server.Default().app.request("/doc")
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(body.openapi).toBe("3.1.1")
    expect(body.paths).toHaveProperty("/global/health")
  })

  test("keeps control-plane routes out of workspace routing", async () => {
    const doc = await Server.Default().app.request("/doc?workspace=wrk_missing")
    const docBody = await doc.json()

    expect(doc.status).toBe(200)
    expect(docBody.paths).toHaveProperty("/global/health")

    const auth = await Server.Default().app.request("/auth/provider_missing", {
      method: "DELETE",
      headers: {
        "x-opencode-workspace": "wrk_missing",
      },
    })

    expect(auth.status).not.toBe(500)
    expect(await auth.text()).not.toContain("Workspace not found")
  })

  test("serves local PTY websocket compatibility with production instance context", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir({ git: true })
    const ptyID = PtyID.ascending()
    const issued = PtyTicket.issue({ ptyID })
    const response = await Server.Default().app.request(
      `/pty/${ptyID}/connect?directory=${encodeURIComponent(tmp.path)}&ticket=${encodeURIComponent(issued.ticket)}`,
    )
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.name).toBe("NotFoundError")
  })

  test("serves instance SSE compatibility with production instance context", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await Server.Default().app.request(`/event?directory=${encodeURIComponent(tmp.path)}`)
    const text = await readFirstChunk(response)

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(text).toContain("server.connected")
  })

  test("serves global SSE special surfaces through the production dispatcher", async () => {
    for (const path of ["/global/event", "/global/sync-event"] as const) {
      const response = await Server.Default().app.request(path)
      const text = await readFirstChunk(response)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(text).toContain("server.connected")
    }
  })

  test("does not mount ordinary API route trees through Hono in production", async () => {
    const server = await readFile(path.join(import.meta.dir, "../../src/server/server.ts"), "utf8")

    expect(server).not.toContain("InstanceRoutes")
    expect(server).not.toContain("ControlPlaneRoutes")
    expect(server).not.toContain("GlobalRoutes")
  })

  test("does not mount the catch-all Hono compatibility app in production", async () => {
    const server = await readFile(path.join(import.meta.dir, "../../src/server/server.ts"), "utf8")

    expect(server).not.toContain("createCompatibilityApp")
    expect(server).not.toContain("compatibility.fetch")
  })

  test("keeps the production server entrypoint free of direct Hono host construction", async () => {
    const server = await readFile(path.join(import.meta.dir, "../../src/server/server.ts"), "utf8")
    const websocketCompatibility = await readFile(
      path.join(import.meta.dir, "../../src/server/websocket-compatibility.ts"),
      "utf8",
    )

    expect(server).not.toMatch(/from\s+["']hono["']/)
    expect(server).not.toMatch(/\bnew\s+Hono\s*\(/)
    expect(websocketCompatibility).toMatch(/from\s+["']hono["']/)
    expect(websocketCompatibility).toMatch(/\bnew\s+Hono\s*\(/)
  })

  test("does not keep a legacy Hono documentation route tree", () => {
    const openapi = path.join(import.meta.dir, "../../src/server/openapi.ts")

    expect(existsSync(openapi)).toBe(false)
  })

  test("keeps production /doc out of the legacy control route tree", async () => {
    const server = await readFile(path.join(import.meta.dir, "../../src/server/server.ts"), "utf8")
    const controlHandler = await readFile(
      path.join(import.meta.dir, "../../src/server/routes/instance/httpapi/handlers/control.ts"),
      "utf8",
    )
    const controlOpenApi = await readFile(path.join(import.meta.dir, "../../src/server/control-openapi.ts"), "utf8")

    expect(server).not.toContain('from "./openapi"')
    expect(server).not.toContain('await import("./openapi")')
    expect(server).toContain('await import("./control-openapi")')
    expect(controlHandler).not.toContain("ControlPlaneRoutes")
    expect(controlHandler).not.toContain('request("/doc")')
    expect(controlHandler).not.toContain("@/server/openapi")
    expect(controlOpenApi).not.toContain("ControlPlaneRoutes")
    expect(controlOpenApi).not.toContain("InstanceRoutes")
    expect(controlOpenApi).not.toContain("GlobalRoutes")
    expect(controlOpenApi).not.toContain("server/instance/global")
    expect(controlOpenApi).not.toContain("from \"hono\"")
  })
})
