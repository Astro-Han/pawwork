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

function hasRoute(routes: ReadonlyArray<{ method: string; path: string }>, method: string, path: string) {
  return routes.some((route) => route.method === method && route.path === path)
}

describe("route inventory harness", () => {
  test("discovers PawWork-owned Hono routes that the checked-in OpenAPI surface can miss", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(hasRoute(inventory.hono.routes, "GET", "/external-result")).toBe(true)
    expect(hasRoute(inventory.hono.routes, "GET", "/memory")).toBe(true)
    expect(hasRoute(inventory.hono.routes, "PATCH", "/memory/disabled")).toBe(true)
    expect(hasRoute(inventory.hono.routes, "POST", "/session/:sessionID/tool/respond")).toBe(true)
    expect(hasRoute(inventory.hono.routes, "GET", "/session/:sessionID/turn/:userMessageID/changes")).toBe(true)

    expect(hasRoute(inventory.openapi.routes, "GET", "/external-result")).toBe(false)
    expect(hasRoute(inventory.legacySdk.routes, "GET", "/external-result")).toBe(false)
    expect(hasRoute(inventory.v2Sdk.routes, "GET", "/external-result")).toBe(true)
  })

  test("classifies compatibility gaps by source instead of treating every missing SDK route as a server gap", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    const externalResult = inventory.rows.find((row) => row.method === "GET" && row.path === "/external-result")
    expect(externalResult).toMatchObject({
      hono: true,
      openapi: false,
      legacySdk: false,
      v2Sdk: true,
      classification: "pawwork-owned-sdk-v2-only",
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
      hono: true,
      openapi: true,
      localHttpApi: true,
      classification: "all-public-surfaces",
    })
    expect(inventory.rows.find((row) => row.method === "PATCH" && row.path === "/config")).toMatchObject({
      hono: true,
      openapi: true,
      localHttpApi: true,
      classification: "all-public-surfaces",
    })
    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/config/providers")).toMatchObject({
      hono: true,
      openapi: true,
      localHttpApi: true,
      classification: "all-public-surfaces",
    })
    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/external-result")).toMatchObject({
      hono: true,
      localHttpApi: true,
      classification: "pawwork-owned-sdk-v2-only",
    })
  })

  test("tracks local HttpApi migration coverage for ordinary JSON file, project, memory, and external-result routes", async () => {
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
      ["GET", "/memory"],
      ["PATCH", "/memory"],
      ["POST", "/memory/reset"],
      ["PATCH", "/memory/disabled"],
      ["DELETE", "/memory/entry/:id"],
      ["GET", "/external-result"],
    ] as const) {
      expect(inventory.rows.find((row) => row.method === method && row.path === routePath)).toMatchObject({
        hono: true,
        localHttpApi: true,
      })
    }

    expect(inventory.rows.find((row) => row.method === "GET" && row.path === "/external-result")).toMatchObject({
      classification: "pawwork-owned-sdk-v2-only",
    })
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
      `,
      "fixture.ts",
    )

    expect(routes).toContainEqual({ method: "GET", path: "/config", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "POST", path: "/session/:sessionID/message", source: "fixture.ts" })
    expect(routes).toContainEqual({ method: "DELETE", path: "/pty/:ptyID", source: "fixture.ts" })
  })

  test("distinguishes non-product Hono and v2 SDK routes from Hono-only routes", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(
      inventory.rows.find((row) => row.method === "POST" && row.path === "/permission/__e2e/ask"),
    ).toMatchObject({ hono: true, openapi: false, v2Sdk: true, classification: "hono-v2-sdk" })
  })

  test("keeps the PTY connect-token route in the public OpenAPI and v2 SDK surfaces", async () => {
    const inventory = await buildRouteInventory({ root, requireUpstream: false })

    expect(inventory.rows.find((row) => row.method === "POST" && row.path === "/pty/:ptyID/connect-token")).toMatchObject({
      hono: true,
      openapi: true,
      v2Sdk: true,
      classification: "openapi-v2-sdk",
      specialSurface: "PTY websocket",
    })
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
        "packages\\opencode\\src\\server\\control\\index.ts",
        "packages\\opencode\\src\\server\\proxy.ts",
      ]),
    ).toEqual([])
  })
})
