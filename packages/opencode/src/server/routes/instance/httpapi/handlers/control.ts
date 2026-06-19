import { Auth } from "@/auth"
import { ProviderID } from "@/provider/schema"
import { Log } from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { resolver } from "hono-openapi"
import z from "zod"
import { ControlPlaneRoutes } from "@/server/control"
import { BadRequestErrorSchema } from "@/server/error"
import { globalEventOpenApiSchema, globalSyncEventOpenApiSchema } from "@/server/instance/global"
import { ControlApi } from "../groups/control"

type OpenApiDocument = {
  paths?: unknown
  components?: {
    schemas?: Record<string, unknown>
  }
}

const LogPayload = z.object({
  service: z.string(),
  level: z.enum(["debug", "info", "error", "warn"]),
  message: z.string(),
  extra: z.record(z.string(), z.any()).optional(),
})

type LogPayload = z.infer<typeof LogPayload>

function isJsonContentType(contentType: string | undefined) {
  // Mirrors hono/validator's jsonRegex, reached through hono-openapi's validator("json").
  return /^application\/([a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=([^;]+))*$/.test(contentType ?? "")
}

function badRequestJson(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status: 400 })
}

function parseJsonBody<T>(request: HttpServerRequest.HttpServerRequest, schema: z.ZodType<T>) {
  return Effect.gen(function* () {
    const body = isJsonContentType(request.headers["content-type"])
      ? yield* request.json.pipe(
          Effect.catch(() => Effect.succeed(HttpServerResponse.raw("Malformed JSON in request body", { status: 400 }))),
        )
      : {}
    if (HttpServerResponse.isHttpServerResponse(body)) return body

    const parsed = schema.safeParse(body)
    if (!parsed.success) return badRequestJson({ data: body, error: parsed.error.issues, success: false })
    return parsed.data
  })
}

function controlFailure(error: unknown) {
  if (error instanceof NamedError) return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 500 }))
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

function writeLog(payload: LogPayload) {
  const logger = Log.create({ service: payload.service })

  switch (payload.level) {
    case "debug":
      logger.debug(payload.message, payload.extra)
      break
    case "info":
      logger.info(payload.message, payload.extra)
      break
    case "error":
      logger.error(payload.message, payload.extra)
      break
    case "warn":
      logger.warn(payload.message, payload.extra)
      break
  }
}

function collectSchemaRefs(value: unknown, refs = new Set<string>()) {
  if (!value || typeof value !== "object") return refs
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, refs)
    return refs
  }

  const record = value as Record<string, unknown>
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/components/schemas/")) refs.add(record.$ref)
  for (const item of Object.values(record)) collectSchemaRefs(item, refs)
  return refs
}

function mergeSchemas(document: OpenApiDocument, schemas: Record<string, unknown>) {
  document.components ??= {}
  document.components.schemas = {
    ...schemas,
    ...document.components.schemas,
  }
}

async function ensureReferencedControlDocSchemas(document: OpenApiDocument) {
  const refs = collectSchemaRefs(document.paths)
  const schemas = document.components?.schemas ?? {}
  const missingGlobalEvent = refs.has("#/components/schemas/GlobalEvent") && !schemas.GlobalEvent
  const missingSyncEvent = refs.has("#/components/schemas/SyncEvent") && !schemas.SyncEvent
  const missingBadRequestError = refs.has("#/components/schemas/BadRequestError") && !schemas.BadRequestError

  if (missingGlobalEvent) {
    const generated = await resolver(globalEventOpenApiSchema()).toOpenAPISchema()
    mergeSchemas(document, generated.components?.schemas ?? {})
  }
  if (missingSyncEvent) {
    const generated = await resolver(globalSyncEventOpenApiSchema()).toOpenAPISchema()
    mergeSchemas(document, generated.components?.schemas ?? {})
  }
  if (missingBadRequestError) {
    const generated = await resolver(BadRequestErrorSchema).toOpenAPISchema()
    mergeSchemas(document, generated.components?.schemas ?? {})
  }
}

async function controlOpenApiDocument() {
  const response = await ControlPlaneRoutes().request("/doc")
  const document = await response.json()
  await ensureReferencedControlDocSchemas(document)
  return document
}

export const controlHandlers = HttpApiBuilder.group(ControlApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (providerID: ProviderID, info: Auth.Info) {
      yield* auth.set(providerID, info)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (providerID: ProviderID) {
      yield* auth.remove(providerID)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (payload: LogPayload) {
      yield* Effect.sync(() => writeLog(payload))
      return true
    })

    return handlers
      .handleRaw("authSet", (ctx) =>
        Effect.gen(function* () {
          const payload = yield* parseJsonBody(ctx.request, Auth.Info.zod)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          return yield* authSet(ctx.params.providerID, payload).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
            Effect.catch(controlFailure),
            Effect.catchDefect(controlFailure),
          )
        }),
      )
      .handleRaw("authRemove", (ctx) =>
        authRemove(ctx.params.providerID).pipe(
          Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
          Effect.catch(controlFailure),
          Effect.catchDefect(controlFailure),
        ),
      )
      .handleRaw("log", (ctx) =>
        Effect.gen(function* () {
          const payload = yield* parseJsonBody(ctx.request, LogPayload)
          if (HttpServerResponse.isHttpServerResponse(payload)) return payload
          return yield* log(payload).pipe(
            Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
            Effect.catch(controlFailure),
            Effect.catchDefect(controlFailure),
          )
        }),
      )
      .handleRaw("doc", () =>
        Effect.promise(() => controlOpenApiDocument()).pipe(Effect.map((document) => HttpServerResponse.jsonUnsafe(document))),
      )
  }),
)
