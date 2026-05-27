import { describe, expect, test } from "bun:test"
import { buildRouteInventory, parseHttpApiRoutesFromText } from "../../script/route-inventory"

const root = new URL("../../../..", import.meta.url).pathname

function hasRoute(routes: ReadonlyArray<{ method: string; path: string }>, method: string, path: string) {
  return routes.some((route) => route.method === method && route.path === path)
}

describe("route inventory harness", () => {
  test("discovers PawWork-owned Hono routes that the checked-in OpenAPI surface can miss", async () => {
    const inventory = await buildRouteInventory({ root })

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
    const inventory = await buildRouteInventory({ root })

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
})
