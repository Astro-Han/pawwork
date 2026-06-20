import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildRouteInventory,
  fetchOpencodeDev,
  findWorkspaceRoot,
  getHonoRouteSourceCoverage,
  getMissingHonoRouteSources,
  parseHttpApiRoutesFromText,
  parseSdkRoutesFromText,
} from "../../script/route-inventory"

const root = findWorkspaceRoot(import.meta.url)

const upstreamOnlyHttpApiRoutes = [
  { method: "GET", path: "/experimental/capabilities" },
  { method: "GET", path: "/project/:projectID/directories" },
  { method: "GET", path: "/pty/shells" },
  { method: "GET", path: "/formatter" },
  { method: "POST", path: "/experimental/control-plane/move-session" },
  { method: "POST", path: "/experimental/project/:projectID/copy/generate-name" },
  { method: "POST", path: "/experimental/session/:sessionID/background" },
]

function buildInventoryWithUpstreamOnlyRoutes() {
  return buildRouteInventory({ root, upstreamHttpApiRoutes: upstreamOnlyHttpApiRoutes, requireUpstream: false })
}

function hasRoute(routes: ReadonlyArray<{ method: string; path: string }>, method: string, path: string) {
  return routes.some((route) => route.method === method && route.path === path)
}

describe("route inventory harness", () => {
  test("tracks PawWork-owned routes covered by the checked-in OpenAPI surface", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(hasRoute(inventory.hono.routes, "GET", "/external-result")).toBe(false)
    expect(hasRoute(inventory.hono.routes, "GET", "/memory")).toBe(false)
    expect(hasRoute(inventory.hono.routes, "PATCH", "/memory/disabled")).toBe(false)
    expect(hasRoute(inventory.hono.routes, "POST", "/session/:sessionID/tool/respond")).toBe(false)
    expect(hasRoute(inventory.hono.routes, "GET", "/session/:sessionID/turn/:userMessageID/changes")).toBe(false)

    expect(hasRoute(inventory.openapi.routes, "GET", "/external-result")).toBe(true)
    expect(hasRoute(inventory.legacySdk.routes, "GET", "/external-result")).toBe(false)
    expect(hasRoute(inventory.v2Sdk.routes, "GET", "/external-result")).toBe(true)
  })

  test("classifies retired PawWork-owned routes by their remaining production sources", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    const externalResult = inventory.rows.find((row) => row.method === "GET" && row.path === "/external-result")
    expect(externalResult).toMatchObject({
      hono: false,
      openapi: true,
      legacySdk: false,
      v2Sdk: true,
      localHttpApi: true,
      classification: "pawwork-owned",
    })

    expect(inventory.counts.openapi).toBeGreaterThanOrEqual(90)
    expect(inventory.counts.legacySdk).toBeGreaterThanOrEqual(60)
    expect(inventory.counts.v2Sdk).toBeGreaterThanOrEqual(100)
  })

  test("tracks local HttpApi migration coverage separately from upstream parity", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/provider"],
      ["GET", "/provider/auth"],
      ["POST", "/provider/:providerID/oauth/authorize"],
      ["POST", "/provider/:providerID/oauth/callback"],
      ["POST", "/provider/recent"],
      ["GET", "/mcp"],
      ["POST", "/mcp"],
      ["POST", "/mcp/:name/auth"],
      ["POST", "/mcp/:name/auth/callback"],
      ["POST", "/mcp/:name/auth/authenticate"],
      ["DELETE", "/mcp/:name/auth"],
      ["POST", "/mcp/:name/connect"],
      ["POST", "/mcp/:name/disconnect"],
      ["GET", "/permission"],
      ["POST", "/permission/:requestID/reply"],
      ["POST", "/experimental/workspace"],
      ["GET", "/experimental/workspace"],
      ["GET", "/experimental/workspace/status"],
      ["DELETE", "/experimental/workspace/:id"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: true,
        localHttpApi: true,
      })
    }
    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/config")).toMatchObject({
      hono: false,
      openapi: true,
      legacySdk: true,
      v2Sdk: true,
      localHttpApi: true,
      classification: "local-httpapi-only",
    })
    expect(inventory.rows.find((row) => row.method === "PATCH" && row.path === "/config")).toMatchObject({
      hono: false,
      openapi: true,
      legacySdk: true,
      v2Sdk: true,
      localHttpApi: true,
      classification: "local-httpapi-only",
    })
    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/config/providers")).toMatchObject({
      hono: false,
      openapi: true,
      legacySdk: true,
      v2Sdk: true,
      localHttpApi: true,
      classification: "local-httpapi-only",
    })
    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/external-result")).toMatchObject({
      hono: false,
      localHttpApi: true,
      classification: "pawwork-owned",
    })
    expect(
      inventory.rows.find((row) => row.method === "POST" && row.path === "/mcp/:name/auth/authenticate"),
    ).toMatchObject({
      hono: true,
      openapi: true,
      legacySdk: true,
      v2Sdk: true,
      localHttpApi: true,
      classification: "all-public-surfaces",
    })
  })

  test("tracks local HttpApi migration coverage for ordinary JSON file and project routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/find"],
      ["GET", "/find/file"],
      ["GET", "/find/symbol"],
      ["GET", "/file"],
      ["GET", "/file/content"],
      ["GET", "/file/status"],
      ["GET", "/project"],
      ["GET", "/project/current"],
      ["POST", "/project/git/init"],
      ["PATCH", "/project/:projectID"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: true,
        localHttpApi: true,
      })
    }
  })

  test("keeps retired memory and external-result routes on the HttpApi production surface only", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/memory"],
      ["PATCH", "/memory"],
      ["POST", "/memory/reset"],
      ["PATCH", "/memory/disabled"],
      ["DELETE", "/memory/entry/:id"],
      ["GET", "/external-result"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        openapi: true,
        v2Sdk: true,
        localHttpApi: true,
        classification: "pawwork-owned",
      })
    }
  })

  test("tracks local HttpApi migration coverage for ordinary experimental JSON routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/experimental/console"],
      ["GET", "/experimental/console/orgs"],
      ["POST", "/experimental/console/switch"],
      ["GET", "/experimental/tool"],
      ["GET", "/experimental/tool/ids"],
      ["GET", "/experimental/resource"],
      ["GET", "/experimental/worktree"],
      ["POST", "/experimental/worktree"],
      ["DELETE", "/experimental/worktree"],
      ["POST", "/experimental/worktree/reset"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: true,
        localHttpApi: true,
      })
    }
  })

  test("tracks local HttpApi migration coverage for root instance JSON routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["POST", "/instance/dispose"],
      ["GET", "/path"],
      ["GET", "/vcs"],
      ["GET", "/vcs/status"],
      ["GET", "/vcs/diff"],
      ["GET", "/vcs/diff/raw"],
      ["POST", "/vcs/apply"],
      ["GET", "/command"],
      ["GET", "/agent"],
      ["GET", "/skill"],
      ["GET", "/lsp"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: true,
        localHttpApi: true,
      })
    }
  })

  test("keeps retired control and global JSON routes out of Hono source", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["PUT", "/auth/:providerID"],
      ["DELETE", "/auth/:providerID"],
      ["POST", "/log"],
      ["GET", "/global/config"],
      ["PATCH", "/global/config"],
      ["GET", "/global/health"],
      ["POST", "/global/dispose"],
      ["POST", "/global/upgrade"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        localHttpApi: true,
      })
    }
  })

  test("keeps retired session JSON routes out of Hono source", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/session"],
      ["POST", "/session"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        openapi: true,
        v2Sdk: true,
        localHttpApi: true,
      })
    }

    for (const [method, routePath, classification] of [
      ["GET", "/session/:sessionID/artifacts", "pawwork-owned"],
      ["GET", "/session/:sessionID/export", "pawwork-owned"],
      ["POST", "/session/:sessionID/tool/respond", "pawwork-owned"],
      ["POST", "/session/:sessionID/turn-change/:messageID/undo", "pawwork-owned"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        openapi: true,
        v2Sdk: true,
        localHttpApi: true,
        classification,
      })
    }
  })

  test("tracks local HttpApi migration coverage for ordinary automation routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/automation"],
      ["POST", "/automation"],
      ["GET", "/automation/:automationID"],
      ["PUT", "/automation/:automationID"],
      ["DELETE", "/automation/:automationID"],
      ["GET", "/automation/:automationID/runs"],
      ["POST", "/automation/:automationID/run"],
      ["POST", "/automation/:automationID/pause"],
      ["POST", "/automation/:automationID/resume"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        openapi: true,
        v2Sdk: true,
        localHttpApi: true,
      })
    }
  })

  test("tracks local HttpApi migration coverage for PTY JSON and control-plane routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/pty"],
      ["POST", "/pty"],
      ["GET", "/pty/:ptyID"],
      ["PUT", "/pty/:ptyID"],
      ["DELETE", "/pty/:ptyID"],
      ["POST", "/pty/:ptyID/connect-token"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: true,
        localHttpApi: true,
      })
    }

    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/pty/:ptyID/connect")).toMatchObject({
      hono: false,
      localHttpApi: false,
      nativeSpecial: true,
      specialSurface: "PTY websocket",
      compatibilityBoundary: false,
      classification: "production-native-special-surface",
    })
    const doc = inventory.rows.find((row) => row.method === "GET" && row.path === "/doc")
    expect(doc).toMatchObject({
      hono: false,
      localHttpApi: true,
      specialSurface: "OpenAPI source",
    })
    expect(doc?.classification).toMatch(/^local-httpapi-(?:only|upstream-only)$/)
    expect(
      inventory.rows.find((row) => row.method === "POST" && row.path === "/permission/__e2e/ask"),
    ).toMatchObject({
      hono: true,
      localHttpApi: true,
    })
  })

  test("tracks local HttpApi coverage for upstream-only backend JSON routes with local semantics", async () => {
    const inventory = await buildInventoryWithUpstreamOnlyRoutes()

    for (const [method, routePath] of [
      ["GET", "/experimental/capabilities"],
      ["GET", "/project/:projectID/directories"],
      ["GET", "/pty/shells"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        localHttpApi: true,
        upstreamHttpApi: true,
        classification: "local-httpapi-upstream-only",
      })
    }
  })

  test("tracks local HttpApi migration coverage for ordinary JSON session routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath] of [
      ["GET", "/session"],
      ["POST", "/session"],
      ["GET", "/session/status"],
      ["POST", "/session/__e2e/update-todos"],
      ["GET", "/session/:sessionID"],
      ["PATCH", "/session/:sessionID"],
      ["DELETE", "/session/:sessionID"],
      ["GET", "/session/:sessionID/children"],
      ["POST", "/session/:sessionID/init"],
      ["GET", "/session/:sessionID/message"],
      ["POST", "/session/:sessionID/message"],
      ["GET", "/session/:sessionID/message/:messageID"],
      ["DELETE", "/session/:sessionID/message/:messageID"],
      ["PATCH", "/session/:sessionID/message/:messageID/part/:partID"],
      ["DELETE", "/session/:sessionID/message/:messageID/part/:partID"],
      ["GET", "/session/:sessionID/todo"],
      ["POST", "/session/:sessionID/prompt_async"],
      ["POST", "/session/:sessionID/abort"],
      ["POST", "/session/:sessionID/command"],
      ["POST", "/session/:sessionID/fork"],
      ["GET", "/session/:sessionID/diff"],
      ["POST", "/session/:sessionID/share"],
      ["DELETE", "/session/:sessionID/share"],
      ["POST", "/session/:sessionID/summarize"],
      ["POST", "/session/:sessionID/shell"],
      ["POST", "/session/:sessionID/revert"],
      ["POST", "/session/:sessionID/unrevert"],
      ["POST", "/session/:sessionID/permissions/:permissionID"],
      ["GET", "/session/:sessionID/artifacts"],
      ["GET", "/session/:sessionID/export"],
      ["POST", "/session/:sessionID/tool/respond"],
      ["GET", "/session/:sessionID/turn-change/:messageID"],
      ["POST", "/session/:sessionID/turn-change/:messageID/undo"],
      ["POST", "/session/:sessionID/turn-change/:messageID/redo"],
      ["GET", "/session/:sessionID/turn/:userMessageID/changes"],
      ["POST", "/session/:sessionID/turn/:userMessageID/changes/undo"],
      ["POST", "/session/:sessionID/turn/:userMessageID/changes/redo"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        localHttpApi: true,
      })
    }
  })

  test("tracks local HttpApi migration coverage for the experimental session list route", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/experimental/session")).toMatchObject({
      hono: true,
      localHttpApi: true,
    })
  })

  test("keeps the session local HttpApi handler importable", async () => {
    const mod = await import("../../src/server/routes/instance/httpapi/handlers/session")

    expect(mod.sessionHandlers).toBeDefined()
  })

  test("parses upstream HttpApi route declarations without requiring a live upstream ref", () => {
    const routes = parseHttpApiRoutesFromText(
      `
      const root = "/session"
      export const SessionPaths = {
        list: root,
        remove: \`\${root}/:sessionID\`,
      } as const

      HttpApiEndpoint.get("list", SessionPaths.list, {})
      HttpApiEndpoint.delete("remove", SessionPaths.remove, {})
      HttpApiEndpoint.del("removeAlias", "/session/:sessionID/message/:messageID", {})
      `,
      "fixture.ts",
    )

    expect(routes).toContainEqual({ method: "GET", path: "/session", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "DELETE", path: "/session/:sessionID", source: "fixture.ts" })
    expect(routes).toContainEqual({
      method: "DELETE",
      path: "/session/:sessionID/message/:messageID",
      source: "fixture.ts",
    })
  })

  test("parses upstream HttpApi route declarations when one add call registers multiple endpoints", () => {
    const routes = parseHttpApiRoutesFromText(
      `
      const root = "/config"

      HttpApiGroup.make("config")
        .add(
          HttpApiEndpoint.get("get", root, {}),
          HttpApiEndpoint.patch("update", root, {}),
          HttpApiEndpoint.get("providers", \`\${root}/providers\`, {}),
        )
      `,
      "fixture.ts",
    )

    expect(routes).toContainEqual({ method: "GET", path: "/config", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "PATCH", path: "/config", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "GET", path: "/config/providers", source: "fixture.ts" })
  })

  test("qualifies upstream HttpApi path object keys when names collide", () => {
    const routes = parseHttpApiRoutesFromText(
      `
      const sessionRoot = "/session"
      const providerRoot = "/provider"
      export const SessionPaths = {
        list: sessionRoot,
      } as const
      export const ProviderPaths = {
        list: providerRoot,
      } as const

      HttpApiEndpoint.get("sessions", SessionPaths.list, {})
      HttpApiEndpoint.get("providers", ProviderPaths.list, {})
      `,
      "fixture.ts",
    )

    expect(routes).toContainEqual({ method: "GET", path: "/session", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "GET", path: "/provider", source: "fixture.ts" })
  })

  test("parses SDK route calls across formatting styles", () => {
    const routes = parseSdkRoutesFromText(
      `
      client.get<Response>({ url: "/config" })
      client.post<Response, Error>({
        url: '/session/{id}/message',
      })
      client.delete<Response>({
        url: \`/pty/{id}\`,
      })
      client.post<Response, Error>(
        {
          url: "/mcp/{name}/auth/authenticate",
        },
      )
      `,
      "fixture.ts",
    )

    expect(routes).toContainEqual({ method: "GET", path: "/config", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "POST", path: "/session/:sessionID/message", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "DELETE", path: "/pty/:ptyID", source: "fixture.ts" })
    expect(routes).toContainEqual({
      method: "POST",
      path: "/mcp/:name/auth/authenticate",
      source: "fixture.ts",
    })
  })

  test("distinguishes non-product Hono and v2 SDK routes from Hono-only routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(
      inventory.rows.find((row) => row.method === "POST" && row.path === "/permission/__e2e/ask"),
    ).toMatchObject({ hono: true, openapi: true, v2Sdk: true, localHttpApi: true, classification: "openapi-v2-sdk" })
  })

  test("does not report retired question HTTP routes as OpenAPI-only residue", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(
      inventory.rows
        .filter((row) => row.path === "/question" || row.path.startsWith("/question/"))
        .filter((row) => row.classification === "openapi-only"),
    ).toEqual([])
  })

  test("tracks native production coverage and adapter compatibility for non-JSON HTTP surfaces", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    for (const [method, routePath, specialSurface] of [
      ["GET", "/event", "SSE/event"],
      ["GET", "/global/event", "SSE/event"],
      ["GET", "/global/sync-event", "SSE/event"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        localHttpApi: false,
        nativeSpecial: true,
        compatibilityBoundary: false,
        classification: "production-native-special-surface",
        specialSurface,
      })
    }

    expect(inventory.rows.find((row) => row.method === "ALL" && row.path === "/*")).toMatchObject({
      hono: true,
      localHttpApi: false,
      nativeSpecial: true,
      compatibilityBoundary: false,
      classification: "production-native-special-surface",
      specialSurface: "UI static route",
    })

    for (const [method, routePath, specialSurface] of [
      ["GET", "/pty/:ptyID/connect", "PTY websocket"],
      ["GET", "/__workspace_ws", "workspace websocket proxy"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        localHttpApi: false,
        nativeSpecial: true,
        compatibilityBoundary: false,
        classification: "production-native-special-surface",
        specialSurface,
      })
    }
  })

  test("keeps the PTY connect-token route in the public OpenAPI and v2 SDK surfaces", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(inventory.rows.find((row) => row.method === "POST" && row.path === "/pty/:ptyID/connect-token")).toMatchObject({
      hono: true,
      openapi: true,
      v2Sdk: true,
      localHttpApi: true,
      classification: "openapi-v2-sdk",
      specialSurface: "PTY websocket",
    })
  })

  test("classifies upstream HttpApi routes without local product semantics as deferred", async () => {
    const inventory = await buildInventoryWithUpstreamOnlyRoutes()

    for (const [method, routePath] of [
      ["GET", "/formatter"],
      ["POST", "/experimental/control-plane/move-session"],
      ["POST", "/experimental/project/:projectID/copy/generate-name"],
      ["POST", "/experimental/session/:sessionID/background"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: false,
        localHttpApi: false,
        upstreamHttpApi: true,
        classification: "explicitly-deferred",
      })
    }
  })

  test("fails when the upstream HttpApi ref is unavailable", async () => {
    await expect(
      buildRouteInventory({
        root,
        upstreamRef: "refs/heads/route-inventory-missing-upstream",
        requireUpstream: true,
      }),
    ).rejects.toThrow(/Unable to read upstream HttpApi route tree/)
  })

  test("fails when the upstream ref does not contain the HttpApi route tree", async () => {
    await expect(
      buildRouteInventory({
        root,
        upstreamRef: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        requireUpstream: true,
      }),
    ).rejects.toThrow(
      /Unable to read upstream HttpApi route tree/,
    )
  })

  test("explains how to configure the opencode remote when fetch fails", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "route-inventory-"))
    try {
      execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" })

      const remoteGuidance = new RegExp(
        [
          "Failed to fetch opencode/dev",
          "git remote rename upstream opencode",
          "git remote add opencode https://github\\.com/anomalyco/opencode\\.git",
        ].join(".*"),
        "s",
      )
      expect(() => fetchOpencodeDev(workspace)).toThrow(remoteGuidance)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("covers every current Hono route implementation module in the inventory source list", async () => {
    const coverage = await getHonoRouteSourceCoverage(root)

    expect(coverage.missing).toEqual([])
  })

  test("matches discovered Hono route modules when Windows uses backslash separators", () => {
    expect(
      getMissingHonoRouteSources([
        "packages\\opencode\\src\\server\\ui\\index.ts",
      ]),
    ).toEqual([])
  })
})
