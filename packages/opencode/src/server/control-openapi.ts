import { OpenApi } from "effect/unstable/httpapi"
import { resolver } from "hono-openapi"
import { Automation } from "@/automation"
import { BusEvent } from "@/bus/bus-event"
import { Info as ConfigInfo } from "@/config/config"
import { LSP } from "@/lsp"
import { ListResult as ProviderListResult, ConfigProvidersResult } from "@/provider/provider"
import { PtyID } from "@/pty/schema"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { TurnChange } from "@/session/turn-change"
import { BadRequestErrorSchema } from "./error"
import { globalEventOpenApiSchema, globalSyncEventOpenApiSchema } from "./global-openapi-schema"
import { ProductionApi } from "./production-api"
import { productionBusEventTypes, productionSyncEventTypes } from "./production-event-sources"

type OpenApiDocument = {
  openapi?: string
  info?: {
    title?: string
    version?: string
    description?: string
  }
  paths?: Record<string, Record<string, any>>
  components?: {
    schemas?: Record<string, unknown>
  }
}

function mergeSchemas(document: OpenApiDocument, schemas: Record<string, unknown>, options?: { override?: boolean }) {
  document.components ??= {}
  document.components.schemas = options?.override
    ? {
        ...document.components.schemas,
        ...schemas,
      }
    : {
        ...schemas,
        ...document.components.schemas,
      }
}

function sortRefUnions(value: unknown) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) sortRefUnions(item)
    return
  }

  const record = value as Record<string, unknown>
  const anyOf = record.anyOf
  if (
    Array.isArray(anyOf) &&
    anyOf.every((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).$ref === "string")
  ) {
    anyOf.sort((left, right) =>
      String((left as Record<string, unknown>).$ref).localeCompare(String((right as Record<string, unknown>).$ref)),
    )
  }
  for (const item of Object.values(record)) sortRefUnions(item)
}

function schemaRef(name: string) {
  return { $ref: `#/components/schemas/${name}` }
}

function arrayOf(schema: unknown) {
  return {
    type: "array",
    items: schema,
  }
}

function messageWithParts(info: unknown = schemaRef("Message")) {
  return {
    type: "object",
    properties: {
      info,
      parts: arrayOf(schemaRef("Part")),
    },
    required: ["info", "parts"],
  }
}

function jsonContent(schema: unknown) {
  return {
    "application/json": {
      schema,
    },
  }
}

function patchJsonResponse(document: OpenApiDocument, path: string, method: string, schema: unknown, status = "200") {
  const operation = document.paths?.[path]?.[method] as
    | { responses?: Record<string, { content?: Record<string, unknown> }> }
    | undefined
  const response = operation?.responses?.[status]
  if (!response) return
  response.content = jsonContent(schema)
}

function patchRequestBody(
  document: OpenApiDocument,
  path: string,
  method: string,
  schema: unknown,
  options?: { required?: boolean },
) {
  const operation = document.paths?.[path]?.[method] as
    | { requestBody?: { required?: boolean; content?: Record<string, unknown> } }
    | undefined
  if (!operation) return
  operation.requestBody = {
    required: options?.required ?? true,
    content: jsonContent(schema),
  }
}

function patchParameterSchemas(
  document: OpenApiDocument,
  path: string,
  method: string,
  schemas: Record<string, unknown>,
) {
  const operation = document.paths?.[path]?.[method] as { parameters?: Array<{ name?: string; schema?: unknown }> } | undefined
  if (!operation?.parameters) return
  for (const parameter of operation.parameters) {
    if (!parameter.name) continue
    const schema = schemas[parameter.name]
    if (schema) parameter.schema = schema
  }
}

function upsertQueryParameters(document: OpenApiDocument, path: string, method: string, parameters: Array<Record<string, unknown>>) {
  const operation = document.paths?.[path]?.[method] as { parameters?: Array<Record<string, unknown>> } | undefined
  if (!operation) return
  operation.parameters ??= []
  for (const parameter of parameters) {
    const existing = operation.parameters.find((item) => item.in === "query" && item.name === parameter.name)
    if (existing) Object.assign(existing, parameter)
    else operation.parameters.push(parameter)
  }
}

function patchSessionSchemas(document: OpenApiDocument, schemas: Record<string, unknown>) {
  const session = schemaRef("Session")
  const message = schemaRef("Message")
  const assistant = schemaRef("AssistantMessage")
  const sessionStatus = schemaRef("SessionStatus")
  const promptBody = schemas.PromptBodyInline
  const commandBody = schemas.CommandBodyInline
  const shellBody = schemas.ShellBodyInline
  const createBody = schemas.SessionCreateBodyInline
  const revertBody = schemas.SessionRevertBodyInline
  const diff = schemaRef("TurnChangeAggregate")
  const todoSnapshot = schemaRef("TodoSnapshot")
  const turnChangeDisplay = schemaRef("TurnChangeDisplay")
  const turnChangeMutation = schemaRef("TurnChangeMutationResult")

  patchParameterSchemas(document, "/session", "get", {
    roots: { type: "boolean" },
    start: { type: "number" },
    limit: { type: "number" },
  })
  patchJsonResponse(document, "/session", "get", arrayOf(session))
  patchRequestBody(document, "/session", "post", createBody, { required: false })
  patchJsonResponse(document, "/session", "post", session)
  patchJsonResponse(document, "/session/status", "get", {
    type: "object",
    additionalProperties: sessionStatus,
  })
  patchJsonResponse(document, "/session/{sessionID}", "get", session)
  patchJsonResponse(document, "/session/{sessionID}", "patch", session)
  patchJsonResponse(document, "/session/{sessionID}/children", "get", arrayOf(session))
  patchParameterSchemas(document, "/session/{sessionID}/message", "get", {
    limit: { type: "number" },
  })
  patchJsonResponse(document, "/session/{sessionID}/message", "get", arrayOf(messageWithParts(message)))
  patchRequestBody(document, "/session/{sessionID}/message", "post", promptBody)
  patchJsonResponse(document, "/session/{sessionID}/message", "post", messageWithParts(assistant))
  patchJsonResponse(document, "/session/{sessionID}/message/{messageID}", "get", messageWithParts(message))
  patchRequestBody(document, "/session/{sessionID}/message/{messageID}/part/{partID}", "patch", schemaRef("Part"))
  patchJsonResponse(document, "/session/{sessionID}/message/{messageID}/part/{partID}", "patch", schemaRef("Part"))
  patchJsonResponse(document, "/session/{sessionID}/todo", "get", todoSnapshot)
  patchRequestBody(document, "/session/{sessionID}/prompt_async", "post", promptBody)
  patchRequestBody(document, "/session/{sessionID}/command", "post", commandBody)
  patchJsonResponse(document, "/session/{sessionID}/command", "post", messageWithParts(assistant))
  patchRequestBody(document, "/session/{sessionID}/fork", "post", schemas.SessionForkBodyInline, { required: false })
  patchJsonResponse(document, "/session/{sessionID}/fork", "post", session)
  patchJsonResponse(document, "/session/{sessionID}/share", "post", session)
  patchJsonResponse(document, "/session/{sessionID}/share", "delete", session)
  patchJsonResponse(document, "/session/{sessionID}/diff", "get", diff)
  patchRequestBody(document, "/session/{sessionID}/shell", "post", shellBody)
  patchJsonResponse(document, "/session/{sessionID}/shell", "post", messageWithParts(message))
  patchRequestBody(document, "/session/{sessionID}/revert", "post", revertBody)
  patchJsonResponse(document, "/session/{sessionID}/revert", "post", session)
  patchJsonResponse(document, "/session/{sessionID}/unrevert", "post", session)
  patchJsonResponse(document, "/session/{sessionID}/turn-change/{messageID}", "get", {
    anyOf: [turnChangeDisplay, { type: "null" }],
  })
  patchJsonResponse(document, "/session/{sessionID}/turn-change/{messageID}/undo", "post", turnChangeMutation)
  patchJsonResponse(document, "/session/{sessionID}/turn-change/{messageID}/redo", "post", turnChangeMutation)
  patchJsonResponse(document, "/session/{sessionID}/turn/{userMessageID}/changes", "get", diff)
  patchJsonResponse(document, "/session/{sessionID}/turn/{userMessageID}/changes/undo", "post", turnChangeMutation)
  patchJsonResponse(document, "/session/{sessionID}/turn/{userMessageID}/changes/redo", "post", turnChangeMutation)
}

function patchAutomationSchemas(document: OpenApiDocument, schemas: Record<string, unknown>) {
  const definition = schemaRef("AutomationDefinition")
  const automationID = { type: "string", pattern: "^automation_(?!run_)" }
  const runID = { type: "string", pattern: "^automation_run_" }
  const runLimit = { type: "integer", exclusiveMinimum: 0, maximum: 100 }

  patchParameterSchemas(document, "/automation/{automationID}", "get", { automationID })
  patchParameterSchemas(document, "/automation/{automationID}", "put", { automationID })
  patchParameterSchemas(document, "/automation/{automationID}", "delete", { automationID })
  patchParameterSchemas(document, "/automation/{automationID}/runs", "get", { automationID, cursor: runID, limit: runLimit })
  patchParameterSchemas(document, "/automation/{automationID}/run", "post", { automationID })
  patchParameterSchemas(document, "/automation/{automationID}/pause", "post", { automationID })
  patchParameterSchemas(document, "/automation/{automationID}/resume", "post", { automationID })

  patchJsonResponse(document, "/automation", "get", schemaRef("AutomationListResponse"))
  patchRequestBody(document, "/automation", "post", schemaRef("AutomationCreateInput"))
  patchJsonResponse(document, "/automation", "post", definition)
  patchJsonResponse(document, "/automation/{automationID}", "get", definition)
  patchRequestBody(document, "/automation/{automationID}", "put", schemaRef("AutomationUpdateInput"))
  patchJsonResponse(document, "/automation/{automationID}", "put", definition)
  patchJsonResponse(document, "/automation/{automationID}", "delete", schemaRef("AutomationDefinitionTombstone"))
  patchJsonResponse(document, "/automation/{automationID}/runs", "get", schemaRef("AutomationRunsResponse"))
  patchJsonResponse(document, "/automation/{automationID}/run", "post", schemaRef("AutomationRun"))
  patchJsonResponse(document, "/automation/{automationID}/pause", "post", definition)
  patchJsonResponse(document, "/automation/{automationID}/resume", "post", definition)
}

function memoryStateSchema() {
  return {
    type: "object",
    properties: {
      path: { type: "string" },
      disabled: { type: "boolean" },
      status: { type: "string", enum: ["ok", "safe_mode"] },
      reason: { type: "string" },
      content: { type: "string" },
      profile: { type: "string" },
      profileTooLarge: { type: "boolean" },
    },
    required: ["path", "disabled", "status", "content"],
  }
}

function patchMemorySchemas(document: OpenApiDocument) {
  const memoryState = schemaRef("MemoryState")
  patchJsonResponse(document, "/memory", "get", memoryState)
  patchRequestBody(document, "/memory", "patch", schemaRef("MemoryRawInput"))
  patchJsonResponse(document, "/memory", "patch", memoryState)
  patchJsonResponse(document, "/memory/reset", "post", memoryState)
  patchRequestBody(document, "/memory/disabled", "patch", schemaRef("MemoryDisabledInput"))
  patchJsonResponse(document, "/memory/disabled", "patch", memoryState)
  patchJsonResponse(document, "/memory/entry/{id}", "delete", memoryState)
}

function patchAdditionalRouteSchemas(document: OpenApiDocument) {
  patchParameterSchemas(document, "/path", "get", {
    ensureConfig: { type: "boolean" },
    ensureSkills: { type: "boolean" },
  })
  patchJsonResponse(document, "/project", "get", arrayOf(schemaRef("Project")))
  patchJsonResponse(document, "/project/current", "get", schemaRef("Project"))
  patchJsonResponse(document, "/project", "patch", schemaRef("Project"))
  patchParameterSchemas(document, "/experimental/session", "get", {
    roots: { type: "boolean" },
    start: { type: "number" },
    limit: { type: "number" },
    archived: { type: "boolean" },
  })
  patchJsonResponse(document, "/experimental/session", "get", arrayOf(schemaRef("GlobalSession")))
  upsertQueryParameters(document, "/experimental/worktree", "get", workspaceRoutingParameters)
  upsertQueryParameters(document, "/experimental/worktree", "post", workspaceRoutingParameters)
  upsertQueryParameters(document, "/experimental/worktree", "delete", workspaceRoutingParameters)
  upsertQueryParameters(document, "/experimental/worktree/reset", "post", workspaceRoutingParameters)
  patchRequestBody(document, "/experimental/worktree", "post", schemaRef("WorktreeCreateInput"), { required: false })
  patchRequestBody(document, "/experimental/worktree", "delete", schemaRef("WorktreeRemoveInput"))
  patchRequestBody(document, "/experimental/worktree/reset", "post", schemaRef("WorktreeResetInput"))
  patchJsonResponse(document, "/permission", "get", arrayOf(schemaRef("PermissionRequest")))
  patchJsonResponse(document, "/external-result", "get", arrayOf(schemaRef("PendingExternalResult")))
  patchJsonResponse(document, "/session/{sessionID}/artifacts", "get", arrayOf(schemaRef("SessionArtifact")))
  patchParameterSchemas(document, "/find/file", "get", {
    limit: { type: "number" },
  })
  patchJsonResponse(document, "/find/symbol", "get", arrayOf(schemaRef("Symbol")))
  patchJsonResponse(document, "/file/content", "get", schemaRef("FileContent"))
}

function patchVcsFailureSchemas(document: OpenApiDocument) {
  patchJsonResponse(document, "/vcs/apply", "post", schemaRef("VcsApplyFailure"), "400")
  patchJsonResponse(document, "/vcs/apply", "post", schemaRef("VcsApplyFailure"), "413")
  patchJsonResponse(document, "/vcs/diff/raw", "get", schemaRef("VcsDiffRawFailure"), "413")
}

function memoryInputSchemas() {
  return {
    MemoryRawInput: {
      type: "object",
      properties: {
        content: { type: "string" },
      },
      required: ["content"],
    },
    MemoryDisabledInput: {
      type: "object",
      properties: {
        disabled: { type: "boolean" },
      },
      required: ["disabled"],
    },
  }
}

function worktreeInputSchemas() {
  return {
    WorktreeCreateInput: {
      type: "object",
      properties: {
        name: { type: "string" },
        startCommand: {
          type: "string",
          description: "Additional startup script to run after the project's start command",
        },
      },
    },
    WorktreeRemoveInput: {
      type: "object",
      properties: {
        directory: { type: "string" },
      },
      required: ["directory"],
    },
    WorktreeResetInput: {
      type: "object",
      properties: {
        directory: { type: "string" },
      },
      required: ["directory"],
    },
  }
}

function fileContentSchema() {
  const patchHunk = {
    type: "object",
    properties: {
      oldStart: { type: "number" },
      oldLines: { type: "number" },
      newStart: { type: "number" },
      newLines: { type: "number" },
      lines: arrayOf({ type: "string" }),
    },
    required: ["oldStart", "oldLines", "newStart", "newLines", "lines"],
  }

  return {
    type: "object",
    properties: {
      type: { type: "string", enum: ["text", "binary"] },
      content: { type: "string" },
      diff: { type: "string" },
      patch: {
        type: "object",
        properties: {
          oldFileName: { type: "string" },
          newFileName: { type: "string" },
          oldHeader: { type: "string" },
          newHeader: { type: "string" },
          hunks: arrayOf(patchHunk),
          index: { type: "string" },
        },
        required: ["oldFileName", "newFileName", "hunks"],
      },
      encoding: { type: "string", enum: ["base64"] },
      mimeType: { type: "string" },
    },
    required: ["type", "content"],
  }
}

function pendingExternalResultSchema() {
  return {
    type: "object",
    properties: {
      session: schemaRef("Session"),
      message: schemaRef("Message"),
      part: schemaRef("Part"),
    },
    required: ["session", "message", "part"],
  }
}

function vcsFailureSchemas() {
  return {
    VcsApplyFailure: {
      type: "object",
      properties: {
        error: { const: "vcs_apply_failed" },
        reason: { enum: ["non-git", "not-clean", "too-large", "invalid-input"] },
        message: { type: "string" },
      },
      required: ["error", "reason", "message"],
      additionalProperties: false,
      description: "VCS patch apply failure",
    },
    VcsDiffRawFailure: {
      type: "object",
      properties: {
        error: { const: "vcs_diff_raw_failed" },
        reason: { const: "too-large" },
        message: { type: "string" },
      },
      required: ["error", "reason", "message"],
      additionalProperties: false,
      description: "Raw VCS diff is too large",
    },
  }
}

const workspaceRoutingParameters = [
  {
    in: "query",
    name: "directory",
    schema: {
      type: "string",
    },
  },
  {
    in: "query",
    name: "workspace",
    schema: {
      type: "string",
    },
  },
]

export async function controlOpenApi() {
  const document = structuredClone(OpenApi.fromApi(ProductionApi) as OpenApiDocument)
  const promptBody = SessionPrompt.PromptInput.omit({ sessionID: true, automationID: true }).meta({ ref: "PromptBody" })
  const commandBody = SessionPrompt.CommandInput.omit({ sessionID: true }).meta({ ref: "CommandBody" })
  const shellBody = SessionPrompt.ShellInput.omit({ sessionID: true }).meta({ ref: "ShellBody" })
  const sessionCreateBody = Session.CreateInput.meta({ ref: "SessionCreateBody" })
  const sessionForkBody = Session.ForkInput.omit({ sessionID: true }).meta({ ref: "SessionForkBody" })
  const sessionRevertBody = SessionRevert.RevertInput.omit({ sessionID: true }).meta({ ref: "SessionRevertBody" })
  const [
    instanceEvent,
    globalEvent,
    globalSyncEvent,
    badRequest,
    config,
    ptyID,
    providerList,
    configProviders,
    sessionInfo,
    globalSessionInfo,
    messageWithParts,
    sessionStatus,
    sessionArtifact,
    lspSymbol,
    prompt,
    command,
    shell,
    sessionCreate,
    sessionFork,
    sessionRevert,
    automationList,
    automationCreate,
    automationUpdate,
    automationDefinition,
    automationTombstone,
    automationRuns,
    automationRun,
    todo,
    turnChangeDisplay,
    turnChangeAggregate,
    turnChangeMutation,
  ] = await Promise.all([
    resolver(BusEvent.payloads({ include: productionBusEventTypes })).toOpenAPISchema(),
    resolver(globalEventOpenApiSchema({ busEventTypes: productionBusEventTypes })).toOpenAPISchema(),
    resolver(globalSyncEventOpenApiSchema({ syncEventTypes: productionSyncEventTypes })).toOpenAPISchema(),
    resolver(BadRequestErrorSchema).toOpenAPISchema(),
    resolver(ConfigInfo.zod).toOpenAPISchema(),
    resolver(PtyID.zod).toOpenAPISchema(),
    resolver(ProviderListResult.zod).toOpenAPISchema(),
    resolver(ConfigProvidersResult.zod).toOpenAPISchema(),
    resolver(Session.Info).toOpenAPISchema(),
    resolver(Session.GlobalInfo).toOpenAPISchema(),
    resolver(MessageV2.WithParts).toOpenAPISchema(),
    resolver(SessionStatus.Info).toOpenAPISchema(),
    resolver(SessionSummary.Artifact).toOpenAPISchema(),
    resolver(LSP.Symbol).toOpenAPISchema(),
    resolver(promptBody).toOpenAPISchema(),
    resolver(commandBody).toOpenAPISchema(),
    resolver(shellBody).toOpenAPISchema(),
    resolver(sessionCreateBody).toOpenAPISchema(),
    resolver(sessionForkBody).toOpenAPISchema(),
    resolver(sessionRevertBody).toOpenAPISchema(),
    resolver(Automation.ListResponse).toOpenAPISchema(),
    resolver(Automation.CreateInput).toOpenAPISchema(),
    resolver(Automation.UpdateInput).toOpenAPISchema(),
    resolver(Automation.Definition).toOpenAPISchema(),
    resolver(Automation.Tombstone).toOpenAPISchema(),
    resolver(Automation.RunsResponse).toOpenAPISchema(),
    resolver(Automation.Run).toOpenAPISchema(),
    resolver(Todo.Snapshot).toOpenAPISchema(),
    resolver(TurnChange.DisplaySchema.meta({ ref: "TurnChangeDisplay" })).toOpenAPISchema(),
    resolver(TurnChange.AggregateSchema.meta({ ref: "TurnChangeAggregate" })).toOpenAPISchema(),
    resolver(TurnChange.MutationResultSchema.meta({ ref: "TurnChangeMutationResult" })).toOpenAPISchema(),
  ])

  document.openapi = "3.1.1"
  document.info = {
    title: "opencode",
    version: "0.0.3",
    description: "opencode api",
  }
  document.paths ??= {}
  delete document.paths["/doc"]
  document.paths["/event"] = {
    get: {
      operationId: "event.subscribe",
      summary: "Subscribe to events",
      description: "Get events",
      parameters: workspaceRoutingParameters,
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: instanceEvent.schema,
            },
          },
        },
      },
    },
  }
  document.paths["/global/event"] = {
    get: {
      operationId: "global.event",
      summary: "Get global events",
      description: "Subscribe to global events from the OpenCode system using server-sent events.",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: globalEvent.schema,
            },
          },
        },
      },
    },
  }
  document.paths["/global/sync-event"] = {
    get: {
      operationId: "global.sync-event.subscribe",
      summary: "Subscribe to global sync events",
      description: "Get global sync events",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: globalSyncEvent.schema,
            },
          },
        },
      },
    },
  }
  document.paths["/pty/{ptyID}/connect"] = {
    get: {
      operationId: "pty.connect",
      summary: "Connect to PTY session",
      description: "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.",
      parameters: [
        ...workspaceRoutingParameters,
        {
          in: "path",
          name: "ptyID",
          schema: ptyID.schema,
          required: true,
        },
        {
          in: "query",
          name: "cursor",
          schema: {
            type: "string",
          },
        },
        {
          in: "query",
          name: "ticket",
          schema: {
            type: "string",
          },
        },
      ],
      responses: {
        101: {
          description: "WebSocket protocol upgrade",
        },
        404: {
          description: "Not found",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/NotFoundError",
              },
            },
          },
        },
      },
    },
  }
  mergeSchemas(document, instanceEvent.components?.schemas ?? {})
  mergeSchemas(document, globalEvent.components?.schemas ?? {})
  mergeSchemas(document, globalSyncEvent.components?.schemas ?? {})
  mergeSchemas(document, ptyID.components?.schemas ?? {})
  mergeSchemas(document, providerList.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, configProviders.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, sessionInfo.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, globalSessionInfo.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, messageWithParts.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, sessionStatus.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, sessionArtifact.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, lspSymbol.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, automationList.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, automationDefinition.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, automationTombstone.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, automationRuns.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, automationRun.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, todo.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, turnChangeDisplay.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, turnChangeMutation.components?.schemas ?? {}, { override: true })
  const sessionPatchSchemas = {
    ...(prompt.components?.schemas ?? {}),
    ...(command.components?.schemas ?? {}),
    ...(shell.components?.schemas ?? {}),
    ...(sessionCreate.components?.schemas ?? {}),
    ...(sessionFork.components?.schemas ?? {}),
    ...(sessionRevert.components?.schemas ?? {}),
    ...(turnChangeAggregate.components?.schemas ?? {}),
  }
  const automationPatchSchemas = {
    ...(automationCreate.components?.schemas ?? {}),
    ...(automationUpdate.components?.schemas ?? {}),
  }
  mergeSchemas(document, automationPatchSchemas, { override: true })
  document.components ??= {}
  document.components.schemas = {
    ...document.components.schemas,
    MemoryState: memoryStateSchema(),
    ...memoryInputSchemas(),
    ...worktreeInputSchemas(),
    FileContent: fileContentSchema(),
    PendingExternalResult: pendingExternalResultSchema(),
    ...vcsFailureSchemas(),
  }
  const sessionPatchRefs = {
    PromptBody: prompt.schema,
    CommandBody: command.schema,
    ShellBody: shell.schema,
    SessionCreateBody: sessionCreate.schema,
    SessionForkBody: sessionFork.schema,
    SessionRevertBody: sessionRevert.schema,
    TurnChangeAggregate: turnChangeAggregate.schema,
    PromptBodyInline: prompt.components?.schemas?.PromptBody ?? prompt.schema,
    CommandBodyInline: command.components?.schemas?.CommandBody ?? command.schema,
    ShellBodyInline: shell.components?.schemas?.ShellBody ?? shell.schema,
    SessionCreateBodyInline: sessionCreate.components?.schemas?.SessionCreateBody ?? sessionCreate.schema,
    SessionForkBodyInline: sessionFork.components?.schemas?.SessionForkBody ?? sessionFork.schema,
    SessionRevertBodyInline: sessionRevert.components?.schemas?.SessionRevertBody ?? sessionRevert.schema,
  }
  const automationPatchRefs = {
    AutomationCreateInputInline: automationCreate.components?.schemas?.AutomationCreateInput ?? automationCreate.schema,
    AutomationUpdateInputInline: automationUpdate.components?.schemas?.AutomationUpdateInput ?? automationUpdate.schema,
  }
  mergeSchemas(document, sessionPatchSchemas, { override: true })
  patchSessionSchemas(document, sessionPatchRefs)
  patchAutomationSchemas(document, automationPatchRefs)
  patchMemorySchemas(document)
  patchAdditionalRouteSchemas(document)
  patchVcsFailureSchemas(document)
  mergeSchemas(document, badRequest.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, config.components?.schemas ?? {}, { override: true })
  sortRefUnions(document)
  return document
}
