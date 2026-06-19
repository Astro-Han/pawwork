import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { controlOpenApi } from "../../src/server/control-openapi"
import { Server } from "../../src/server/server"

const expectedProductionEventSchemaRefs = [
  "Event.automation.definition.deleted",
  "Event.automation.definition.updated",
  "Event.automation.run.updated",
  "Event.command.executed",
  "Event.file.edited",
  "Event.file.watcher.rescan",
  "Event.file.watcher.updated",
  "Event.global.disposed",
  "Event.installation.update-available",
  "Event.installation.updated",
  "Event.lsp.client.diagnostics",
  "Event.lsp.server.install.failed",
  "Event.lsp.updated",
  "Event.mcp.browser.open.failed",
  "Event.mcp.tools.changed",
  "Event.message.part.delta",
  "Event.message.part.removed",
  "Event.message.part.updated",
  "Event.message.removed",
  "Event.message.updated",
  "Event.permission.asked",
  "Event.permission.replied",
  "Event.project.updated",
  "Event.pty.created",
  "Event.pty.deleted",
  "Event.pty.exited",
  "Event.pty.updated",
  "Event.server.connected",
  "Event.server.instance.disposed",
  "Event.session.compacted",
  "Event.session.created",
  "Event.session.deleted",
  "Event.session.diff",
  "Event.session.error",
  "Event.session.idle",
  "Event.session.status",
  "Event.session.turn_change_invalidated",
  "Event.session.updated",
  "Event.todo.updated",
  "Event.vcs.branch.updated",
  "Event.workspace.failed",
  "Event.workspace.ready",
  "Event.workspace.status",
  "Event.worktree.failed",
  "Event.worktree.ready",
]

const expectedProductionSyncEventSchemaRefs = [
  "SyncEvent.message.part.removed",
  "SyncEvent.message.part.updated",
  "SyncEvent.message.removed",
  "SyncEvent.message.updated",
  "SyncEvent.session.created",
  "SyncEvent.session.deleted",
  "SyncEvent.session.updated",
]

function eventSchemaRefs(spec: Awaited<ReturnType<typeof controlOpenApi>>) {
  const eventSchema = spec.components?.schemas?.Event as { anyOf?: Array<{ $ref?: string }> } | undefined
  return (eventSchema?.anyOf ?? [])
    .map((item) => item.$ref?.replace("#/components/schemas/", ""))
    .filter((item): item is string => Boolean(item))
}

function syncEventSchemaRefs(spec: Awaited<ReturnType<typeof controlOpenApi>>) {
  return Object.keys(spec.components?.schemas ?? {})
    .filter((name) => name.startsWith("SyncEvent."))
    .sort()
}

function requestBodySchemaRef(spec: Awaited<ReturnType<typeof controlOpenApi>>, routePath: string, method: string) {
  const operation = spec.paths?.[routePath]?.[method] as
    | { requestBody?: { content?: { "application/json"?: { schema?: { $ref?: string } } } } }
    | undefined
  return operation?.requestBody?.content?.["application/json"]?.schema?.$ref
}

function queryParameterSchema(spec: Awaited<ReturnType<typeof controlOpenApi>>, routePath: string, method: string, name: string) {
  const operation = spec.paths?.[routePath]?.[method] as
    | { parameters?: Array<{ in?: string; name?: string; schema?: unknown }> }
    | undefined
  return operation?.parameters?.find((parameter) => parameter.in === "query" && parameter.name === name)?.schema
}

function jsonResponseSchema(spec: Awaited<ReturnType<typeof controlOpenApi>>, routePath: string, method: string) {
  const operation = spec.paths?.[routePath]?.[method] as
    | { responses?: Record<string, { content?: { "application/json"?: { schema?: unknown } } }> }
    | undefined
  return operation?.responses?.["200"]?.content?.["application/json"]?.schema
}

function generateAfterIsolatedEventLeak() {
  const script = `
    import z from "zod"
    const { BusEvent } = await import("./src/bus/bus-event.ts")
    const { controlOpenApi } = await import("./src/server/control-openapi.ts")

    BusEvent.define("test.openapi.leak", z.object({ value: z.number() }))
    const spec = await controlOpenApi()
    const eventRefs = (spec.components?.schemas?.Event?.anyOf ?? [])
      .map((item) => item.$ref?.replace("#/components/schemas/", ""))
      .filter(Boolean)
    const syncRefs = Object.keys(spec.components?.schemas ?? {})
      .filter((name) => name.startsWith("SyncEvent."))
      .sort()

    console.log(JSON.stringify({ eventRefs, syncRefs }))
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: path.join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })

  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())
  return JSON.parse(Buffer.from(result.stdout).toString()) as { eventRefs: string[]; syncRefs: string[] }
}

describe("OpenAPI generation source", () => {
  test("reuses the shared ProductionApi for dispatch and documentation", async () => {
    const controlOpenApiSource = await readFile(path.join(import.meta.dir, "../../src/server/control-openapi.ts"), "utf8")
    const productionHttpApiSource = await readFile(
      path.join(import.meta.dir, "../../src/server/production-httpapi.ts"),
      "utf8",
    )

    expect(controlOpenApiSource).toContain('import { ProductionApi } from "./production-api"')
    expect(productionHttpApiSource).toContain('import { ProductionApi } from "./production-api"')
    expect(productionHttpApiSource).not.toContain('HttpApi.make("production")')
  })

  test("generates the production Effect HttpApi document directly", async () => {
    const spec = await controlOpenApi()

    expect(spec.openapi).toBe("3.1.1")
    expect(spec.paths).not.toHaveProperty("/doc")
    expect(spec.paths).toHaveProperty("/event")
    expect(spec.paths).toHaveProperty("/global/sync-event")
    expect(spec.paths).toHaveProperty("/pty/{ptyID}/connect")
    expect(spec.paths).toHaveProperty("/automation/{automationID}/run")
    expect(spec.paths).toHaveProperty("/memory/entry/{id}")
    expect(spec.paths).toHaveProperty("/session/{sessionID}/tool/respond")
    expect(spec.paths).toHaveProperty("/provider/recent")
    expect(spec.paths).not.toHaveProperty("/question")

    const ptyConnectOperation = spec.paths?.["/pty/{ptyID}/connect"] as
      | { get?: { responses?: Record<string, unknown> } }
      | undefined
    const ptyConnectResponses = ptyConnectOperation?.get?.responses ?? {}
    expect(ptyConnectResponses).toHaveProperty("101")
    expect(ptyConnectResponses).not.toHaveProperty("200")
    expect(ptyConnectResponses["101"]).not.toHaveProperty("content")
  })

  test("generates the full production event schema without import-order dependence", async () => {
    const spec = await controlOpenApi()
    const isolatedLeakSpec = generateAfterIsolatedEventLeak()

    expect(eventSchemaRefs(spec)).toEqual(expectedProductionEventSchemaRefs)
    expect(syncEventSchemaRefs(spec)).toEqual(expectedProductionSyncEventSchemaRefs)
    expect(isolatedLeakSpec.eventRefs).toEqual(expectedProductionEventSchemaRefs)
    expect(isolatedLeakSpec.syncRefs).toEqual(expectedProductionSyncEventSchemaRefs)
  })

  test("preserves config zod override schemas in the production document", async () => {
    const spec = await controlOpenApi()
    const schemas = spec.components?.schemas ?? {}

    expect(schemas).toHaveProperty("AgentConfig")
    expect(JSON.stringify(schemas.Config)).toContain("#/components/schemas/AgentConfig")
  })

  test("keeps generated SDK parameter and response shapes compatible with the production source", async () => {
    const spec = await controlOpenApi()
    const schemas = spec.components?.schemas as Record<string, any>

    expect(requestBodySchemaRef(spec, "/memory", "patch")).toBe("#/components/schemas/MemoryRawInput")
    expect(requestBodySchemaRef(spec, "/memory/disabled", "patch")).toBe("#/components/schemas/MemoryDisabledInput")
    expect(requestBodySchemaRef(spec, "/automation", "post")).toBe("#/components/schemas/AutomationCreateInput")
    expect(requestBodySchemaRef(spec, "/automation/{automationID}", "put")).toBe(
      "#/components/schemas/AutomationUpdateInput",
    )
    expect(requestBodySchemaRef(spec, "/experimental/worktree", "post")).toBe(
      "#/components/schemas/WorktreeCreateInput",
    )
    expect(requestBodySchemaRef(spec, "/experimental/worktree", "delete")).toBe(
      "#/components/schemas/WorktreeRemoveInput",
    )
    expect(requestBodySchemaRef(spec, "/experimental/worktree/reset", "post")).toBe(
      "#/components/schemas/WorktreeResetInput",
    )

    expect(queryParameterSchema(spec, "/path", "get", "ensureConfig")).toMatchObject({ type: "boolean" })
    expect(queryParameterSchema(spec, "/session/{sessionID}/message", "get", "limit")).toMatchObject({
      type: "number",
    })
    expect(queryParameterSchema(spec, "/experimental/session", "get", "roots")).toMatchObject({ type: "boolean" })
    expect(queryParameterSchema(spec, "/experimental/session", "get", "start")).toMatchObject({ type: "number" })
    expect(queryParameterSchema(spec, "/experimental/session", "get", "limit")).toMatchObject({ type: "number" })
    expect(queryParameterSchema(spec, "/experimental/session", "get", "archived")).toMatchObject({ type: "boolean" })
    expect(queryParameterSchema(spec, "/find/file", "get", "limit")).toMatchObject({ type: "number" })

    expect(jsonResponseSchema(spec, "/project", "get")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Project" },
    })
    expect(jsonResponseSchema(spec, "/permission", "get")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/PermissionRequest" },
    })
    expect(jsonResponseSchema(spec, "/external-result", "get")).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/PendingExternalResult" },
    })
    expect(schemas.PendingExternalResult.properties).toMatchObject({
      session: { $ref: "#/components/schemas/Session" },
      message: { $ref: "#/components/schemas/Message" },
      part: { $ref: "#/components/schemas/Part" },
    })
    expect(schemas.FileContent.properties.patch.properties.hunks.items.properties).toMatchObject({
      oldStart: { type: "number" },
      oldLines: { type: "number" },
      newStart: { type: "number" },
      newLines: { type: "number" },
      lines: { type: "array", items: { type: "string" } },
    })
  })

  test("keeps the public generated OpenAPI path set aligned with the production source", async () => {
    const checkedIn = JSON.parse(await readFile(path.join(import.meta.dir, "../../../sdk/openapi.json"), "utf8"))
    const generated = await Server.openapi()
    const production = await controlOpenApi()
    const checkedInPaths = new Set(Object.keys(checkedIn.paths ?? {}))
    const generatedPaths = new Set(Object.keys(generated.paths ?? {}))
    const productionPaths = new Set(Object.keys(production.paths ?? {}))

    expect(generated.info).toEqual(production.info)
    expect([...productionPaths].filter((routePath) => !generatedPaths.has(routePath)).sort()).toEqual([])
    expect([...generatedPaths].filter((routePath) => !productionPaths.has(routePath)).sort()).toEqual([])
    expect([...productionPaths].filter((routePath) => !checkedInPaths.has(routePath)).sort()).toEqual([])
    expect([...checkedInPaths].filter((routePath) => !productionPaths.has(routePath)).sort()).toEqual([])
  })
})
