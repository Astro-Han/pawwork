import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { mapValues } from "remeda"
import { ConfigApi } from "../groups/config"

const getWith = Effect.fn("ConfigHttpApi.get")(function* (config: Config.Interface) {
  return HttpServerResponse.jsonUnsafe(yield* config.get())
})

const providersWith = Effect.fn("ConfigHttpApi.providers")(function* (provider: Provider.Interface) {
  const providers = yield* provider.list()
  return HttpServerResponse.jsonUnsafe({
    providers: Object.values(providers),
    default: mapValues(providers, (item) => Provider.defaultModelID(item)),
  })
})

function isJsonContentType(contentType: string | undefined) {
  // Mirrors hono/validator's jsonRegex, reached through hono-openapi's validator("json").
  return /^application\/([a-z-.]+\+)?json(?:;\s*[a-zA-Z0-9-]+=([^;]+))*$/.test(contentType ?? "")
}

function badRequestJson(body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status: 400 })
}

export const configHandlers = HttpApiBuilder.group(ConfigApi, "config", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service

    return handlers
      .handle("get", () => getWith(config))
      .handleRaw("update", (ctx) =>
        Effect.gen(function* () {
          // Use Hono's strict Config.Info.zod contract instead of HttpApi payload decoding, which strips excess fields.
          const body = isJsonContentType(ctx.request.headers["content-type"])
            ? yield* ctx.request.json.pipe(
                Effect.catch(() => Effect.succeed(HttpServerResponse.raw("Malformed JSON in request body", { status: 400 }))),
              )
            : {}
          if (HttpServerResponse.isHttpServerResponse(body)) return body
          const parsed = Config.Info.zod.safeParse(body)
          if (!parsed.success) return badRequestJson({ data: body, error: parsed.error.issues, success: false })
          yield* config.update(parsed.data)
          return HttpServerResponse.jsonUnsafe(parsed.data)
        }),
      )
      .handle("providers", () => providersWith(provider))
  }),
)
