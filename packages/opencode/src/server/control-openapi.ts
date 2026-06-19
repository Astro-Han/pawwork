import { OpenApi } from "effect/unstable/httpapi"
import { resolver } from "hono-openapi"
import { BusEvent } from "@/bus/bus-event"
import { Info as ConfigInfo } from "@/config/config"
import { PtyID } from "@/pty/schema"
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
  paths?: Record<string, Record<string, unknown>>
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
  const [instanceEvent, globalEvent, globalSyncEvent, badRequest, config, ptyID] = await Promise.all([
    resolver(BusEvent.payloads({ include: productionBusEventTypes })).toOpenAPISchema(),
    resolver(globalEventOpenApiSchema({ busEventTypes: productionBusEventTypes })).toOpenAPISchema(),
    resolver(globalSyncEventOpenApiSchema({ syncEventTypes: productionSyncEventTypes })).toOpenAPISchema(),
    resolver(BadRequestErrorSchema).toOpenAPISchema(),
    resolver(ConfigInfo.zod).toOpenAPISchema(),
    resolver(PtyID.zod).toOpenAPISchema(),
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
  mergeSchemas(document, badRequest.components?.schemas ?? {}, { override: true })
  mergeSchemas(document, config.components?.schemas ?? {}, { override: true })
  sortRefUnions(document)
  return document
}
