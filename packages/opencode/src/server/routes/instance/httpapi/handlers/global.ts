import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import { Installation } from "@/installation"
import { Instance } from "@/project/instance"
import { withRequestContext, type RequestContextSnapshot } from "@/server/request-context"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { GlobalApi } from "../groups/global"

const UpgradePayload = z.object({
  target: z.string().optional(),
})

function isJsonContentType(contentType: string | undefined) {
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

function safeHeaderToken(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 100) return "unknown"
  if (/[/\\]|https?:\/\//i.test(trimmed)) return "unknown"
  if (/token|secret|bearer|sk-|cookie|password/i.test(trimmed)) return "unknown"
  if (!/^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return "unknown"
  return trimmed
}

function globalRequestContext(request: HttpServerRequest.HttpServerRequest): RequestContextSnapshot {
  const clientActionID = safeHeaderToken(request.headers["x-pawwork-client-action-id"])
  const clientActionKind = safeHeaderToken(request.headers["x-pawwork-client-action-kind"])
  const routeSessionID = safeHeaderToken(request.headers["x-pawwork-route-session-id"])
  const visibleSessionID = safeHeaderToken(request.headers["x-pawwork-visible-session-id"])
  const client_action = clientActionID
    ? {
        id: clientActionID,
        kind: clientActionKind ?? "unknown",
        route_session_id: routeSessionID,
        visible_session_id: visibleSessionID,
      }
    : undefined

  return {
    method: request.method,
    path: new URL(request.url, "http://localhost").pathname,
    source: client_action ? "renderer" : "local_api",
    client_action,
  }
}

function emitGlobalDisposed() {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: "global.disposed",
      properties: {},
    },
  })
}

const upgradeInstallation = Effect.fn("GlobalHttpApi.upgrade")(function* (target?: string) {
  const installation = yield* Installation.Service
  const method = yield* installation.method()
  if (method === "unknown") {
    return { success: false, status: 400, error: "Unknown installation method" } as const
  }

  const resolvedTarget = target || (yield* installation.latest(method))
  const result = yield* Effect.catch(
    installation.upgrade(method, resolvedTarget).pipe(Effect.as({ success: true as const, version: resolvedTarget })),
    (err) =>
      Effect.succeed({
        success: false as const,
        status: 500 as const,
        error: err instanceof Error ? err.message : String(err),
      }),
  )
  if (!result.success) return result
  return { ...result, status: 200 } as const
})

export const globalHandlers = HttpApiBuilder.group(GlobalApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    return handlers
      .handleRaw("configGet", () => config.getGlobal().pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))))
      .handleRaw("configUpdate", (ctx) =>
        Effect.gen(function* () {
          const body = yield* parseJsonBody(ctx.request, Config.Info.zod)
          if (HttpServerResponse.isHttpServerResponse(body)) return body
          yield* config.updateGlobal(body)
          return HttpServerResponse.jsonUnsafe(body)
        }),
      )
      .handleRaw("health", () =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ healthy: true, version: Installation.VERSION })),
      )
      .handleRaw("dispose", (ctx) =>
        Effect.promise(() =>
          withRequestContext(globalRequestContext(ctx.request), () =>
            Instance.disposeAll({ onCompleted: emitGlobalDisposed }),
          ),
        ).pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
      )
      .handleRaw("upgrade", (ctx) =>
        Effect.gen(function* () {
          const body = yield* parseJsonBody(ctx.request, UpgradePayload)
          if (HttpServerResponse.isHttpServerResponse(body)) return body

          const result = yield* upgradeInstallation(body.target)
          if (!result.success) {
            return HttpServerResponse.jsonUnsafe({ success: false, error: result.error }, { status: result.status })
          }

          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: Installation.Event.Updated.type,
              properties: { version: result.version },
            },
          })
          return HttpServerResponse.jsonUnsafe({ success: true, version: result.version })
        }),
      )
  }),
)
