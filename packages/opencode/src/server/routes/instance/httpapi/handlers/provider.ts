import { authorizeProvider, completeProviderAuth, fetchProviderModels, getAuthMethods, listProviders, recordRecentModel } from "@/server/instance/provider-actions"
import { ProviderAuth } from "@/provider/auth"
import { ModelID, ProviderID } from "@/provider/schema"
import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import z from "zod"
import { ProviderApi } from "../groups/provider"

const RecentModelInput = z.object({
  providerID: ProviderID.zod,
  modelID: ModelID.zod,
})

function isJsonContentType(contentType: string | undefined) {
  // Mirrors hono/validator's jsonRegex, reached through hono-openapi's validator("json").
  return /^application\/([a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=([^;]+))*$/.test(contentType ?? "")
}

function badRequestJson(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status: 400 })
}

function isProviderAuthBadRequest(error: unknown): error is ProviderAuth.Error & { toObject: () => unknown } {
  return (
    error instanceof ProviderAuth.ValidationFailed ||
    error instanceof ProviderAuth.OauthMissing ||
    error instanceof ProviderAuth.OauthCodeMissing ||
    error instanceof ProviderAuth.OauthCallbackFailed
  )
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

function providerAuthFailure(error: ProviderAuth.Error) {
  if (isProviderAuthBadRequest(error)) {
    return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
  }
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      new NamedError.Unknown({ message: "Unexpected server error. Check server logs for details." }).toObject(),
      { status: 500 },
    ),
  )
}

export const providerHandlers = HttpApiBuilder.group(ProviderApi, "provider", (handlers) =>
  handlers
    .handle("list", () =>
      listProviders().pipe(
        Effect.map((providers) => HttpServerResponse.jsonUnsafe(providers)),
      ),
    )
    .handle("auth", () =>
      getAuthMethods().pipe(
        Effect.map((methods) => HttpServerResponse.jsonUnsafe(methods)),
      ),
    )
    .handleRaw("authorize", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, ProviderAuth.AuthorizeInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        const result = yield* authorizeProvider({
          providerID: ctx.params.providerID,
          method: payload.method,
          inputs: payload.inputs,
        }).pipe(Effect.catch(providerAuthFailure))
        if (HttpServerResponse.isHttpServerResponse(result)) return result
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )
    .handleRaw("callback", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, ProviderAuth.CallbackInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        const result = yield* completeProviderAuth({
          providerID: ctx.params.providerID,
          method: payload.method,
          code: payload.code,
        }).pipe(
          Effect.as(true),
          Effect.catch(providerAuthFailure),
        )
        if (HttpServerResponse.isHttpServerResponse(result)) return result
        return HttpServerResponse.jsonUnsafe(result)
      }),
    )
    .handleRaw("recent", (ctx) =>
      Effect.gen(function* () {
        const payload = yield* parseJsonBody(ctx.request, RecentModelInput)
        if (HttpServerResponse.isHttpServerResponse(payload)) return payload
        yield* recordRecentModel(payload)
        return HttpServerResponse.jsonUnsafe(true)
      }),
    )
    .handleRaw("fetchModels", (ctx) =>
      Effect.gen(function* () {
        const result = yield* fetchProviderModels({ providerID: ctx.params.providerID })
        if (!result.ok) return HttpServerResponse.jsonUnsafe({ message: result.message }, { status: 400 })
        return HttpServerResponse.jsonUnsafe({ models: result.models })
      }),
    ),
)
