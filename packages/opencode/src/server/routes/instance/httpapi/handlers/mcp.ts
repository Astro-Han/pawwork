import { Config } from "@/config/config"
import {
  addMcpServer,
  authenticateMcp,
  completeMcpAuth,
  connectMcpServer,
  disconnectMcpServer,
  getMcpStatus,
  removeMcpAuth,
  startMcpAuth,
} from "@/server/instance/mcp-actions"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { McpApi } from "../groups/mcp"

const AddMcpInput = z.object({
  name: z.string(),
  config: Config.Mcp,
})

const AuthCallbackInput = z.object({
  code: z.string(),
})

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

function mcpFailure(error: unknown) {
  if (error instanceof NotFoundError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 404 }))
  }
  if (error instanceof NamedError) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 500 }))
  }
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

function asMcpResponse<A>(effect: Effect.Effect<A, unknown, unknown>) {
  return effect.pipe(
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body)),
    Effect.catch(mcpFailure),
    Effect.catchDefect(mcpFailure),
  )
}

function unsupportedOAuth(name: string) {
  return HttpServerResponse.jsonUnsafe({ error: `MCP server ${name} does not support OAuth` }, { status: 400 })
}

export const mcpHandlers = HttpApiBuilder.group(McpApi, "mcp", (handlers) =>
  handlers
    .handleRaw("status", () => asMcpResponse(getMcpStatus()))
    .handleRaw("add", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, AddMcpInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        const result = yield* addMcpServer(payload)
        return HttpServerResponse.jsonUnsafe(result.status)
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    )
    .handleRaw("authStart", (ctx) =>
      Effect.gen(function* () {
        const result = yield* startMcpAuth(ctx.params.name)
        if (result.type === "unsupported") {
          return unsupportedOAuth(ctx.params.name)
        }
        return HttpServerResponse.jsonUnsafe({
          authorizationUrl: result.authorizationUrl,
          oauthState: result.oauthState,
        })
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    )
    .handleRaw("authCallback", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, AuthCallbackInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        const status = yield* completeMcpAuth({ name: ctx.params.name, code: payload.code })
        return HttpServerResponse.jsonUnsafe(status)
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    )
    .handleRaw("authAuthenticate", (ctx) =>
      Effect.gen(function* () {
        const result = yield* authenticateMcp(ctx.params.name)
        if (result.type === "unsupported") {
          return unsupportedOAuth(ctx.params.name)
        }
        return HttpServerResponse.jsonUnsafe(result.status)
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    )
    .handleRaw("authRemove", (ctx) =>
      Effect.gen(function* () {
        yield* removeMcpAuth(ctx.params.name)
        return HttpServerResponse.jsonUnsafe({ success: true as const })
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    )
    .handleRaw("connect", (ctx) =>
      Effect.gen(function* () {
        yield* connectMcpServer(ctx.params.name)
        return HttpServerResponse.jsonUnsafe(true)
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    )
    .handleRaw("disconnect", (ctx) =>
      Effect.gen(function* () {
        yield* disconnectMcpServer(ctx.params.name)
        return HttpServerResponse.jsonUnsafe(true)
      }).pipe(Effect.catch(mcpFailure), Effect.catchDefect(mcpFailure)),
    ),
)
