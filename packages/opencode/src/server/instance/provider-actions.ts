import { Effect } from "effect"
import { mapValues } from "remeda"
import { Auth } from "../../auth"
import { Config } from "../../config/config"
import { FetchModels } from "../../provider/fetch-models"
import { ModelState } from "../../provider/model-state"
import { ModelsDev } from "../../provider/models"
import { withPawWorkProviders } from "../../provider/pawwork-providers"
import { ProviderAuth } from "../../provider/auth"
import { Provider } from "../../provider/provider"
import { ModelID, ProviderID } from "../../provider/schema"

export const listProviders = Effect.fn("ProviderHttpApi.list")(function* () {
  const config = yield* Config.Service
  const modelsDev = yield* ModelsDev.Service
  const provider = yield* Provider.Service
  const [configInfo, modelsDevProviders, connected] = yield* Effect.all(
    [config.get(), modelsDev.data().pipe(Effect.orDie), provider.list()],
    { concurrency: "unbounded" },
  )
  const allProviders = withPawWorkProviders(modelsDevProviders)
  const disabled = new Set(configInfo.disabled_providers ?? [])
  const enabled = configInfo.enabled_providers ? new Set(configInfo.enabled_providers) : undefined

  const filteredProviders: Record<string, (typeof allProviders)[string]> = {}
  for (const [key, value] of Object.entries(allProviders)) {
    if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
      filteredProviders[key] = value
    }
  }

  const providers = Object.assign(
    mapValues(filteredProviders, (item) => Provider.fromModelsDevProvider(item)),
    connected,
  )
  return {
    all: Object.values(providers),
    default: mapValues(providers, (item) => Provider.defaultModelID(item)),
    connected: Object.keys(connected),
  }
})

export const getAuthMethods = Effect.fn("ProviderHttpApi.auth.methods")(function* () {
  const auth = yield* ProviderAuth.Service
  return yield* auth.methods()
})

export const authorizeProvider = Effect.fn("ProviderHttpApi.oauth.authorize")(function* (input: {
  providerID: ProviderID
  method: number
  inputs?: Record<string, string>
}) {
  const auth = yield* ProviderAuth.Service
  return yield* auth.authorize(input)
})

export const completeProviderAuth = Effect.fn("ProviderHttpApi.oauth.callback")(function* (input: {
  providerID: ProviderID
  method: number
  code?: string
}) {
  const auth = yield* ProviderAuth.Service
  yield* auth.callback(input)
})

export const recordRecentModel = Effect.fn("ProviderHttpApi.recent.record")(function* (input: ModelState.ModelRef) {
  const modelState = yield* ModelState.Service
  yield* modelState.recordRecent(input)
})

export type FetchProviderModelsResult =
  | { ok: true; models: FetchModels.Parsed[] }
  // The message carries the human-readable cause (status text, timeout, non-JSON); the app surfaces it
  // verbatim and does not branch on a code, so no numeric status is returned. Issue #1463.
  | { ok: false; message: string }

// Live-discover an OpenAI-compatible provider's models by calling its `/models` endpoint with the
// provider's already-configured base URL + auth + headers. The base URL comes from the user's config
// override when present, otherwise the models.dev catalog entry (so connected providers like Kilo
// Gateway work without re-entering anything). This only reads and returns the parsed list; persisting
// the chosen additions is the app's job (merge into config.provider.<id>.models). Issue #1463.
export const fetchProviderModels = Effect.fn("ProviderHttpApi.models.fetch")(function* (input: {
  providerID: ProviderID
}) {
  const config = yield* Config.Service
  const auth = yield* Auth.Service
  const modelsDev = yield* ModelsDev.Service

  const [configInfo, authInfo, modelsDevProviders] = yield* Effect.all(
    [
      config.get(),
      auth.get(input.providerID).pipe(Effect.orElseSucceed(() => undefined)),
      modelsDev.data().pipe(Effect.orElseSucceed(() => ({}) as Record<string, ModelsDev.Provider>)),
    ],
    { concurrency: "unbounded" },
  )

  const catalog = withPawWorkProviders(modelsDevProviders)[input.providerID]
  const resolved = FetchModels.request({
    configOptions: configInfo.provider?.[input.providerID]?.options,
    authKey: authInfo?.type === "api" ? authInfo.key : undefined,
    catalogBaseURL: catalog?.api,
  })
  if (!resolved) {
    return { ok: false as const, message: "No base URL configured for this provider" }
  }
  const { baseURL, headers } = resolved

  return yield* Effect.promise(async (): Promise<FetchProviderModelsResult> => {
    try {
      const response = await fetch(FetchModels.endpoint(baseURL), { headers, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) {
        return {
          ok: false,
          message: `Provider returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        }
      }
      let json: unknown
      try {
        json = await response.json()
      } catch {
        return { ok: false, message: "Provider returned a non-JSON response" }
      }
      return { ok: true, models: FetchModels.parse(json) }
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, message: "Request timed out" }
      }
      return { ok: false, message: error instanceof Error ? error.message : "Request failed" }
    }
  })
})
