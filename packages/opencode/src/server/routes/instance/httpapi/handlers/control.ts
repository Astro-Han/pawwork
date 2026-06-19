import { Auth } from "@/auth"
import { ProviderID } from "@/provider/schema"
import { Log } from "@opencode-ai/core/util/log"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { controlOpenApi } from "@/server/control-openapi"
import { ControlApi } from "../groups/control"

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
        Effect.promise(() => controlOpenApi()).pipe(Effect.map((document) => HttpServerResponse.jsonUnsafe(document))),
      )
  }),
)
