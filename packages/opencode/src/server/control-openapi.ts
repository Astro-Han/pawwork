import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { resolver } from "hono-openapi"
import { BadRequestErrorSchema } from "./error"
import { globalEventOpenApiSchema, globalSyncEventOpenApiSchema } from "./global-openapi-schema"
import { ControlApi } from "./routes/instance/httpapi/groups/control"
import { GlobalApi } from "./routes/instance/httpapi/groups/global"

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

const ControlDocApi = HttpApi.make("controlDoc").addHttpApi(ControlApi).addHttpApi(GlobalApi)

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

export async function controlOpenApi() {
  const document = structuredClone(OpenApi.fromApi(ControlDocApi) as OpenApiDocument)
  const [globalEvent, globalSyncEvent, badRequest] = await Promise.all([
    resolver(globalEventOpenApiSchema()).toOpenAPISchema(),
    resolver(globalSyncEventOpenApiSchema()).toOpenAPISchema(),
    resolver(BadRequestErrorSchema).toOpenAPISchema(),
  ])

  document.openapi = "3.1.1"
  document.info = {
    title: "opencode",
    version: "0.0.3",
    description: "opencode api",
  }
  document.paths ??= {}
  delete document.paths["/doc"]
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
  mergeSchemas(document, globalEvent.components?.schemas ?? {})
  mergeSchemas(document, globalSyncEvent.components?.schemas ?? {})
  mergeSchemas(document, badRequest.components?.schemas ?? {}, { override: true })
  return document
}
