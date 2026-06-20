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

  test("creates sessions through the production HttpApi dispatcher with header-scoped instance routing", async () => {
    await using tmp = await tmpdir({ git: true })

    try {
      const response = await Server.Default().app.request("/session", {
        method: "POST",
        headers: {
          "x-opencode-directory": encodeURIComponent(tmp.path),
        },
      })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(body.id).toStartWith("ses_")
      expect(body.directory).toBe(tmp.path)
    } finally {
      await Instance.disposeAll()
    }
  })

  test("serves experimental worktree and workspace routes through the production HttpApi dispatcher", async () => {
    await using tmp = await tmpdir({ git: true })
    const headers = {
      "x-opencode-directory": encodeURIComponent(tmp.path),
    }

    try {
      const worktrees = await Server.Default().app.request("/experimental/worktree", { headers })
      expect(worktrees.status).toBe(200)
      expect(await worktrees.json()).toBeArray()

      const workspaces = await Server.Default().app.request("/experimental/workspace", { headers })
      expect(workspaces.status).toBe(200)
      expect(await workspaces.json()).toEqual([])
    } finally {
      await Instance.disposeAll()
    }
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
    expect(server).not.toContain("createWebSocketCompatibilityApp")
    expect(server).not.toContain("mountWebSocketApp")
    expect(websocketCompatibility).not.toMatch(/from\s+["']hono["']/)
    expect(websocketCompatibility).not.toMatch(/\bnew\s+Hono\s*\(/)
  })

  test("keeps the adapter app contract at the Web Fetch boundary", async () => {
    const adapter = await readFile(path.join(import.meta.dir, "../../src/server/adapter.ts"), "utf8")
    const nodeAdapter = await readFile(path.join(import.meta.dir, "../../src/server/adapter.node.ts"), "utf8")
    const bunAdapter = await readFile(path.join(import.meta.dir, "../../src/server/adapter.bun.ts"), "utf8")

    expect(adapter).not.toMatch(/from\s+["']hono["']/)
    expect(adapter).toMatch(/create\(app:\s*FetchApp\):\s*Runtime/)
    expect(adapter).toMatch(/upgradeWebSocket:\s*UpgradeWebSocket/)
    expect(adapter).not.toMatch(/mountWebSocketApp/)
    expect(adapter).not.toMatch(/create\(app:\s*Hono/)
    expect(adapter).not.toMatch(/websocketApp:\s*Hono/)
    expect(nodeAdapter).toMatch(/\bnew\s+Hono\s*\(/)
    expect(nodeAdapter).not.toMatch(/mountWebSocketApp/)
    expect(bunAdapter).toMatch(/\bnew\s+Hono\s*\(/)
    expect(bunAdapter).not.toMatch(/mountWebSocketApp/)
    expect(bunAdapter).not.toMatch(/create\(app:\s*Hono/)
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

  test("does not retain retired control or global legacy Hono route sources", async () => {
    const globalEvents = await readFile(path.join(import.meta.dir, "../../src/server/instance/global.ts"), "utf8")

    expect(existsSync(path.join(import.meta.dir, "../../src/server/control/index.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/routes/control/index.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/routes/global.ts"))).toBe(false)
    expect(globalEvents).not.toMatch(/\bnew\s+Hono\s*\(/)
    expect(globalEvents).not.toContain("createGlobalRoutes")
    expect(globalEvents).not.toContain("export const GlobalRoutes")
    expect(globalEvents).toContain("handleGlobalEventStream")
    expect(globalEvents).toContain("handleGlobalSyncEventStream")
  })

  test("does not retain retired memory or external-result legacy Hono route sources", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")
    const memory = await readFile(path.join(import.meta.dir, "../../src/server/instance/memory.ts"), "utf8")
    const externalResult = await readFile(
      path.join(import.meta.dir, "../../src/server/instance/external-result.ts"),
      "utf8",
    )

    expect(instanceRoutes).not.toContain("MemoryRoutes")
    expect(instanceRoutes).not.toContain("ExternalResultRoutes")
    for (const source of [memory, externalResult]) {
      expect(source).not.toMatch(/from\s+["']hono["']/)
      expect(source).not.toMatch(/\bnew\s+Hono\s*\(/)
    }
    expect(memory).not.toContain("export const MemoryRoutes")
    expect(externalResult).not.toContain("export const ExternalResultRoutes")
  })

  test("does not retain the retired automation legacy Hono route source", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")
    const automation = path.join(import.meta.dir, "../../src/server/instance/automation.ts")

    expect(existsSync(automation)).toBe(false)
    expect(instanceRoutes).not.toContain("AutomationRoutes")
    expect(instanceRoutes).not.toContain('.route("/automation"')
  })

  test("does not retain the retired config legacy Hono route source", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")
    const config = path.join(import.meta.dir, "../../src/server/instance/config.ts")

    expect(existsSync(config)).toBe(false)
    expect(instanceRoutes).not.toContain("ConfigRoutes")
    expect(instanceRoutes).not.toContain('.route("/config"')
  })

  test("does not retain retired experimental or workspace legacy Hono route sources", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")

    expect(existsSync(path.join(import.meta.dir, "../../src/server/instance/experimental.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/instance/workspace.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/routes/instance/experimental.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/routes/control/workspace.ts"))).toBe(false)
    expect(instanceRoutes).not.toContain("ExperimentalRoutes")
    expect(instanceRoutes).not.toContain('.route("/experimental"')
  })

  test("does not retain retired provider, MCP, or permission legacy Hono route sources", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")

    expect(existsSync(path.join(import.meta.dir, "../../src/server/instance/provider.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/instance/mcp.ts"))).toBe(false)
    expect(existsSync(path.join(import.meta.dir, "../../src/server/instance/permission.ts"))).toBe(false)
    expect(instanceRoutes).not.toContain("ProviderRoutes")
    expect(instanceRoutes).not.toContain("McpRoutes")
    expect(instanceRoutes).not.toContain("PermissionRoutes")
    expect(instanceRoutes).not.toContain('.route("/provider"')
    expect(instanceRoutes).not.toContain('.route("/mcp"')
    expect(instanceRoutes).not.toContain('.route("/permission"')
  })

  test("does not retain retired file or project legacy Hono route sources", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")
    const file = path.join(import.meta.dir, "../../src/server/instance/file.ts")
    const project = path.join(import.meta.dir, "../../src/server/instance/project.ts")

    expect(existsSync(file)).toBe(false)
    expect(existsSync(project)).toBe(false)
    expect(instanceRoutes).not.toContain("FileRoutes")
    expect(instanceRoutes).not.toContain("ProjectRoutes")
    expect(instanceRoutes).not.toContain('.route("/", FileRoutes()')
    expect(instanceRoutes).not.toContain('.route("/project"')
  })

  test("does not retain the retired session legacy Hono route source", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")
    const session = await readFile(path.join(import.meta.dir, "../../src/server/instance/session.ts"), "utf8")

    expect(instanceRoutes).not.toContain("SessionRoutes")
    expect(instanceRoutes).not.toContain('.route("/session"')
    expect(session).not.toMatch(/from\s+["']hono["']/)
    expect(session).not.toMatch(/\bnew\s+Hono\s*\(/)
    expect(session).not.toContain("export const SessionRoutes")
    expect(session).toContain("export const SessionRouteEffects")
  })

  test("does not retain the retired PTY ordinary legacy Hono route source", async () => {
    const instanceRoutes = await readFile(path.join(import.meta.dir, "../../src/server/instance/index.ts"), "utf8")
    const pty = await readFile(path.join(import.meta.dir, "../../src/server/instance/pty.ts"), "utf8")

    expect(instanceRoutes).not.toContain("PtyRoutes")
    expect(instanceRoutes).not.toContain('.route("/pty"')
    expect(pty).not.toMatch(/from\s+["']hono["']/)
    expect(pty).not.toMatch(/\bnew\s+Hono\s*\(/)
    expect(pty).not.toContain("export function PtyRoutes")
    expect(pty).toContain("createPtyConnectEvents")
  })
})
