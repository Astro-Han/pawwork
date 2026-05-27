#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Route = {
  method: string
  path: string
  source?: string
}

export type RouteRow = {
  method: string
  path: string
  hono: boolean
  openapi: boolean
  legacySdk: boolean
  v2Sdk: boolean
  upstreamHttpApi: boolean
  classification: string
  specialSurface: string
}

export type RouteInventory = {
  baseline: {
    pawworkCommit: string
    upstreamCommit?: string
  }
  counts: {
    hono: number
    openapi: number
    legacySdk: number
    v2Sdk: number
    upstreamHttpApi: number
  }
  hono: { routes: Route[] }
  openapi: { routes: Route[] }
  legacySdk: { routes: Route[] }
  v2Sdk: { routes: Route[] }
  upstreamHttpApi: { routes: Route[] }
  rows: RouteRow[]
}

type BuildOptions = {
  root?: string
  upstreamRef?: string
  requireUpstream?: boolean
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

const honoRouteSources = [
  ["packages/opencode/src/server/control/index.ts", ""],
  ["packages/opencode/src/server/instance/config.ts", "/config"],
  ["packages/opencode/src/server/instance/event.ts", ""],
  ["packages/opencode/src/server/instance/experimental.ts", "/experimental"],
  ["packages/opencode/src/server/instance/external-result.ts", "/external-result"],
  ["packages/opencode/src/server/instance/file.ts", ""],
  ["packages/opencode/src/server/instance/global.ts", "/global"],
  ["packages/opencode/src/server/instance/index.ts", ""],
  ["packages/opencode/src/server/instance/mcp.ts", "/mcp"],
  ["packages/opencode/src/server/instance/memory.ts", "/memory"],
  ["packages/opencode/src/server/instance/permission.ts", "/permission"],
  ["packages/opencode/src/server/instance/project.ts", "/project"],
  ["packages/opencode/src/server/instance/provider.ts", "/provider"],
  ["packages/opencode/src/server/instance/pty.ts", "/pty"],
  ["packages/opencode/src/server/instance/session.ts", "/session"],
  ["packages/opencode/src/server/instance/workspace.ts", "/experimental/workspace"],
] as const

const specialSurfaces: Array<[RegExp, string]> = [
  [/^GET \/global\/(?:sync-)?event$/, "SSE/event"],
  [/^GET \/event$/, "SSE/event"],
  [/^GET \/pty\/:ptyID\/connect$/, "PTY websocket"],
  [/^GET \/__workspace_ws$/, "workspace websocket proxy"],
  [/^ALL \/\*$/, "UI static route"],
  [/^GET \/doc$/, "OpenAPI source"],
  [/\/auth\b|\/oauth\//, "auth"],
  [/^\/experimental\/workspace\b/, "workspace"],
]

const pawworkOwned = new Set([
  "GET /global/sync-event",
  "GET /session/:sessionID/artifacts",
  "GET /session/:sessionID/export",
  "GET /external-result",
  "GET /memory",
  "PATCH /memory",
  "POST /memory/reset",
  "PATCH /memory/disabled",
  "DELETE /memory/entry/:id",
  "POST /session/:sessionID/tool/respond",
  "GET /session/:sessionID/turn-change/:messageID",
  "POST /session/:sessionID/turn-change/:messageID/undo",
  "POST /session/:sessionID/turn-change/:messageID/redo",
  "GET /session/:sessionID/turn/:userMessageID/changes",
  "POST /session/:sessionID/turn/:userMessageID/changes/undo",
  "POST /session/:sessionID/turn/:userMessageID/changes/redo",
])

const explicitlyDeferred = [
  /^GET \/api\/session$/,
  /^POST \/api\/session\/:sessionID\/prompt$/,
  /^POST \/api\/session\/:sessionID\/compact$/,
  /^POST \/api\/session\/:sessionID\/wait$/,
  /^GET \/api\/session\/:sessionID\/context$/,
  /^GET \/api\/session\/:sessionID\/message$/,
  /^GET \/api\/model$/,
  /^GET \/api\/provider$/,
  /^GET \/api\/provider\/:providerID$/,
  /^\/tui\//,
  /^\/sync\//,
  /^\/experimental\/workspace\/(?:adapter|sync-list|warp)$/,
]

function repoRoot(input?: string) {
  if (input) return path.resolve(input)
  return findWorkspaceRoot(import.meta.url)
}

export function findWorkspaceRoot(start: string) {
  let dir = start.startsWith("file:") ? path.dirname(fileURLToPath(start)) : path.resolve(start)
  if (existsSync(dir) && !path.extname(dir)) {
    dir = path.resolve(dir)
  } else {
    dir = path.dirname(dir)
  }
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "bun.lock")) && existsSync(path.join(dir, "packages/opencode/package.json"))) {
      return dir
    }
    dir = path.dirname(dir)
  }
  return path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
}

function routeKey(route: Pick<Route, "method" | "path">) {
  return `${route.method} ${route.path}`
}

function normalizePath(value: string) {
  const pathOnly = value
    .replace(/\{([^}]+)\}/g, ":$1")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
  return canonicalizeParams(pathOnly === "" ? "/" : pathOnly)
}

function canonicalizeParams(routePath: string) {
  return routePath
    .replace(/^\/auth\/:id\b/, "/auth/:providerID")
    .replace(/^\/provider\/:id\/oauth\b/, "/provider/:providerID/oauth")
    .replace(/^\/pty\/:id\b/, "/pty/:ptyID")
    .replace(/^\/session\/:id\b/, "/session/:sessionID")
}

function joinRoute(prefix: string, child: string) {
  if (child === "/*") return normalizePath(`${prefix}/*`)
  if (child === "/" || child === "") return normalizePath(prefix || "/")
  return normalizePath(`${prefix}/${child.replace(/^\//, "")}`)
}

function uniqueRoutes(routes: Route[]) {
  const seen = new Map<string, Route>()
  for (const route of routes) {
    const normalized = { ...route, path: normalizePath(route.path) }
    seen.set(routeKey(normalized), normalized)
  }
  return [...seen.values()].sort((a, b) => routeKey(a).localeCompare(routeKey(b)))
}

async function readText(file: string) {
  return readFile(file, "utf8")
}

async function discoverHonoRoutes(root: string): Promise<Route[]> {
  const routes: Route[] = []
  const routePattern = /\.(get|post|put|patch|delete|all)\s*\(\s*(["'`])([^"'`]+)\2/g
  for (const [relative, prefix] of honoRouteSources) {
    const file = path.join(root, relative)
    if (!existsSync(file)) continue
    const text = await readText(file)
    for (const match of text.matchAll(routePattern)) {
      const method = match[1]!.toUpperCase()
      const routePath = match[3]!
      if (!routePath.startsWith("/")) continue
      routes.push({ method, path: joinRoute(prefix, routePath), source: relative })
    }
  }
  // These runtime routes are wired through UI/proxy setup instead of ordinary route modules.
  routes.push({ method: "ALL", path: "/*", source: "packages/opencode/src/server/ui/index.ts" })
  routes.push({ method: "GET", path: "/__workspace_ws", source: "packages/opencode/src/server/proxy.ts" })
  return uniqueRoutes(routes)
}

async function readOpenApiRoutes(root: string): Promise<Route[]> {
  const file = path.join(root, "packages/sdk/openapi.json")
  const spec = JSON.parse(await readText(file)) as { paths?: Record<string, Record<string, unknown>> }
  const routes: Route[] = []
  for (const [routePath, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      const upper = method.toUpperCase()
      if (!HTTP_METHODS.has(upper)) continue
      routes.push({ method: upper, path: normalizePath(routePath), source: "packages/sdk/openapi.json" })
    }
  }
  return uniqueRoutes(routes)
}

export function parseSdkRoutesFromText(text: string, source: string): Route[] {
  const routes: Route[] = []
  const routePattern = /\.(get|post|put|patch|delete)(?:\.sse)?<[^>]*>\(\{\s*url:\s*(["'`])([^"'`]+)\2/g
  for (const match of text.matchAll(routePattern)) {
    routes.push({ method: match[1]!.toUpperCase(), path: normalizePath(match[3]!), source })
  }
  return uniqueRoutes(routes)
}

async function readSdkRoutes(root: string, relative: string): Promise<Route[]> {
  try {
    return parseSdkRoutesFromText(await readText(path.join(root, relative)), relative)
  } catch {
    return []
  }
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

function parseConstStrings(text: string) {
  const values = new Map<string, string>()
  for (const match of text.matchAll(/const\s+(\w+)\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    values.set(match[1]!, match[2]!)
  }
  return values
}

function resolveTemplatePath(raw: string, constants: Map<string, string>) {
  return raw.replace(/\$\{([^}]+)\}/g, (_, name: string) => constants.get(name.trim()) ?? `:${name.trim()}`)
}

export function parseHttpApiRoutesFromText(text: string, source: string): Route[] {
  const constants = parseConstStrings(text)
  const pathValues = new Map<string, string>()

  for (const objectMatch of text.matchAll(/export\s+const\s+(\w*Paths)\s*=\s*\{([\s\S]*?)\}\s+as\s+const/g)) {
    const objectName = objectMatch[1]!
    const body = objectMatch[2]!
    for (const entry of body.matchAll(/(\w+):\s*(["'`])([^"'`]+)\2/g)) {
      const value = resolveTemplatePath(entry[3]!, constants)
      pathValues.set(`${objectName}.${entry[1]!}`, value)
      pathValues.set(entry[1]!, value)
    }
    for (const entry of body.matchAll(/(\w+):\s*(\w+)\s*(?:,|\n)/g)) {
      const value = constants.get(entry[2]!)
      if (value) {
        pathValues.set(`${objectName}.${entry[1]!}`, value)
        pathValues.set(entry[1]!, value)
      }
    }
  }

  const routes: Route[] = []
  const endpointPattern = /HttpApiEndpoint\.(get|post|put|patch|del|delete)\(\s*["'][^"']+["']\s*,\s*([^,\n)]+)/g
  for (const match of text.matchAll(endpointPattern)) {
    const method = match[1] === "del" || match[1] === "delete" ? "DELETE" : match[1]!.toUpperCase()
    const pathExpr = match[2]!.trim()
    let routePath: string | undefined
    const literal = pathExpr.match(/^(["'`])([^"'`]+)\1$/)
    if (literal) routePath = resolveTemplatePath(literal[2]!, constants)
    else {
      const key = pathExpr.split(".").pop()
      routePath = pathValues.get(pathExpr) ?? (key ? pathValues.get(key) : undefined)
    }
    if (routePath) routes.push({ method, path: normalizePath(routePath), source })
  }
  return routes
}

async function readUpstreamHttpApiRoutes(root: string, ref: string, required: boolean): Promise<Route[]> {
  let files: string[]
  try {
    files = git(root, ["ls-tree", "-r", "--name-only", ref, "packages/opencode/src/server/routes/instance/httpapi"])
      .split("\n")
      .filter((file) => file.endsWith(".ts"))
  } catch (error) {
    if (required) {
      throw new Error(`Unable to read upstream HttpApi route tree from ${ref}`, { cause: error })
    }
    return []
  }
  if (required && files.length === 0) {
    throw new Error(`Unable to read upstream HttpApi route tree from ${ref}: no TypeScript route files found`)
  }

  const routes: Route[] = []
  for (const file of files) {
    let text = ""
    try {
      text = git(root, ["show", `${ref}:${file}`])
    } catch {
      continue
    }
    routes.push(...parseHttpApiRoutesFromText(text, `${ref}:${file}`))
  }
  const unique = uniqueRoutes(routes)
  if (required && unique.length === 0) {
    throw new Error(`Unable to read upstream HttpApi route tree from ${ref}: no HttpApi routes parsed`)
  }
  return unique
}

function specialSurfaceFor(method: string, routePath: string) {
  const key = `${method} ${routePath}`
  return specialSurfaces.find(([pattern]) => pattern.test(key) || pattern.test(routePath))?.[1] ?? "-"
}

function classify(input: {
  method: string
  path: string
  hono: boolean
  openapi: boolean
  legacySdk: boolean
  v2Sdk: boolean
  upstreamHttpApi: boolean
}) {
  const key = `${input.method} ${input.path}`
  if (explicitlyDeferred.some((pattern) => pattern.test(key) || pattern.test(input.path))) return "explicitly-deferred"
  if (pawworkOwned.has(key) && input.hono && !input.openapi && !input.legacySdk && input.v2Sdk) {
    return "pawwork-owned-sdk-v2-only"
  }
  if (pawworkOwned.has(key) && input.hono) return "pawwork-owned"
  if (input.hono && input.openapi && input.v2Sdk) return input.legacySdk ? "all-public-surfaces" : "openapi-v2-sdk"
  if (input.hono && input.v2Sdk && !input.openapi) return "hono-v2-sdk"
  if (input.hono && !input.openapi) return "hono-only"
  if (!input.hono && input.upstreamHttpApi) return "onlyHttpApi"
  if (input.openapi && !input.hono) return "openapi-only"
  if (input.legacySdk || input.v2Sdk) return "sdk-only"
  return "unknown"
}

export async function buildRouteInventory(options: BuildOptions = {}): Promise<RouteInventory> {
  const root = repoRoot(options.root)
  const upstreamRef = options.upstreamRef ?? "FETCH_HEAD"
  const requireUpstream = options.requireUpstream ?? false
  const [hono, openapi, legacySdk, v2Sdk, upstreamHttpApi] = await Promise.all([
    discoverHonoRoutes(root),
    readOpenApiRoutes(root),
    readSdkRoutes(root, "packages/sdk/js/src/gen/sdk.gen.ts"),
    readSdkRoutes(root, "packages/sdk/js/src/v2/gen/sdk.gen.ts"),
    readUpstreamHttpApiRoutes(root, upstreamRef, requireUpstream),
  ])

  const sets = {
    hono: new Set(hono.map(routeKey)),
    openapi: new Set(openapi.map(routeKey)),
    legacySdk: new Set(legacySdk.map(routeKey)),
    v2Sdk: new Set(v2Sdk.map(routeKey)),
    upstreamHttpApi: new Set(upstreamHttpApi.map(routeKey)),
  }

  const keys = new Set<string>()
  for (const set of Object.values(sets)) for (const key of set) keys.add(key)

  const rows = [...keys]
    .sort()
    .map((key): RouteRow => {
      const [method, ...pathParts] = key.split(" ")
      const routePath = pathParts.join(" ")
      const flags = {
        method: method!,
        path: routePath,
        hono: sets.hono.has(key),
        openapi: sets.openapi.has(key),
        legacySdk: sets.legacySdk.has(key),
        v2Sdk: sets.v2Sdk.has(key),
        upstreamHttpApi: sets.upstreamHttpApi.has(key),
      }
      return {
        ...flags,
        classification: classify(flags),
        specialSurface: specialSurfaceFor(flags.method, flags.path),
      }
    })

  let upstreamCommit: string | undefined
  try {
    upstreamCommit = git(root, ["rev-parse", upstreamRef])
  } catch {
    upstreamCommit = undefined
  }

  let pawworkCommit = "unknown"
  try {
    pawworkCommit = git(root, ["rev-parse", "HEAD"])
  } catch {
    pawworkCommit = "unknown"
  }

  return {
    baseline: {
      pawworkCommit,
      upstreamCommit,
    },
    counts: {
      hono: hono.length,
      openapi: openapi.length,
      legacySdk: legacySdk.length,
      v2Sdk: v2Sdk.length,
      upstreamHttpApi: upstreamHttpApi.length,
    },
    hono: { routes: hono },
    openapi: { routes: openapi },
    legacySdk: { routes: legacySdk },
    v2Sdk: { routes: v2Sdk },
    upstreamHttpApi: { routes: upstreamHttpApi },
    rows,
  }
}

export function renderRouteInventoryReport(inventory: RouteInventory) {
  const lines = [
    "# Route Inventory: PawWork Hono, OpenAPI, SDK, and Upstream HttpApi",
    "",
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Baseline",
    "",
    `- PawWork commit: \`${inventory.baseline.pawworkCommit}\``,
    `- Upstream \`anomalyco/opencode dev\` commit: \`${inventory.baseline.upstreamCommit ?? "unavailable"}\``,
    "- PawWork Hono source: `packages/opencode/src/server/**`",
    "- Checked-in OpenAPI source: `packages/sdk/openapi.json`",
    "- Legacy SDK source: `packages/sdk/js/src/gen/sdk.gen.ts`",
    "- v2 SDK source: `packages/sdk/js/src/v2/gen/sdk.gen.ts`",
    "",
    "## Summary",
    "",
    `- Hono source routes: ${inventory.counts.hono}`,
    `- Checked-in OpenAPI method routes: ${inventory.counts.openapi}`,
    `- Legacy generated SDK route calls: ${inventory.counts.legacySdk}`,
    `- v2 generated SDK route calls: ${inventory.counts.v2Sdk}`,
    `- Upstream parsed HttpApi method routes: ${inventory.counts.upstreamHttpApi}`,
    "",
    "## Main Table",
    "",
    "| Path | Method | Hono | OpenAPI | Legacy SDK | v2 SDK | Upstream HttpApi | Classification | Special surface |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
  ]

  for (const row of inventory.rows) {
    lines.push(
      `| \`${row.path}\` | \`${row.method}\` | ${mark(row.hono)} | ${mark(row.openapi)} | ${mark(row.legacySdk)} | ${mark(row.v2Sdk)} | ${mark(row.upstreamHttpApi)} | \`${row.classification}\` | ${row.specialSurface} |`,
    )
  }

  lines.push(
    "",
    "## Special Surfaces",
    "",
    "- `/doc`, UI static routing, workspace proxy WebSocket, SSE/event streams, and PTY WebSocket are compatibility boundaries rather than ordinary JSON route parity.",
    "- PawWork-owned routes must be preserved during future HttpApi migration even when they are absent upstream or absent from the checked-in OpenAPI file.",
    "- v2 SDK coverage is tracked separately from the legacy SDK because PawWork-owned app/runtime routes currently appear in the v2 generated SDK surface.",
    "",
    "## Observations",
    "",
    "- This report is a guardrail only. It does not prove request bodies, response schemas, status codes, streaming behavior, WebSocket lifecycle, middleware behavior, or SDK type compatibility.",
    "- Future migration slices should use this inventory to decide whether a route is PawWork-owned, upstream-only, explicitly deferred, or a normal public route before moving implementation code.",
  )

  return `${lines.join("\n")}\n`
}

function mark(value: boolean) {
  return value ? "yes" : "no"
}

async function main() {
  const root = repoRoot()
  git(root, ["fetch", "upstream", "dev"])
  const inventory = await buildRouteInventory({ root, requireUpstream: true })
  const report = renderRouteInventoryReport(inventory)
  const date = new Date().toISOString().slice(0, 10)
  const out = path.join(root, "docs/research", `${date}-route-inventory.md`)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, report)
  console.log(out)
}

if (import.meta.main) {
  await main()
}
