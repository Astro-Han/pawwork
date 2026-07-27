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

function resolveModelDiscovery(input: {
  providerID: string
  provider?: Provider.Info
  catalog?: ModelsDev.Provider
  auth?: Auth.Info
}) {
  if (input.auth?.type === "oauth") return undefined

  const provider = input.provider
  const providerNPMs = new Set<string>()
  for (const model of Object.values(provider?.models ?? {})) providerNPMs.add(model.api.npm)

  const providerModelAPIs = new Set(
    Object.values(provider?.models ?? {})
      .map((model) => model.api.url.trim())
      .filter((api): api is string => Boolean(api)),
  )
  const providerBaseURL = providerModelAPIs.size === 1 ? providerModelAPIs.values().next().value : undefined

  return FetchModels.resolve({
    providerID: input.providerID,
    providerNPMs,
    configOptions: provider?.options,
    authKey: provider?.key ?? (input.auth?.type === "api" ? input.auth.key : undefined),
    providerBaseURL,
    catalogBaseURL: input.catalog?.api,
  })
}

export const listProviders = Effect.fn("ProviderHttpApi.list")(function* () {
  const config = yield* Config.Service
  const auth = yield* Auth.Service
  const modelsDev = yield* ModelsDev.Service
  const provider = yield* Provider.Service
  const [configInfo, authInfo, modelsDevProviders, connected] = yield* Effect.all(
    [config.get(), auth.all().pipe(Effect.orDie), modelsDev.data().pipe(Effect.orDie), provider.list()],
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
    all: Object.values(providers).map((item) => ({
      ...item,
      canFetchModels: Boolean(
        resolveModelDiscovery({
          providerID: item.id,
          provider: item,
          catalog: allProviders[item.id],
          auth: authInfo[item.id],
        }),
      ),
    })),
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

// Live-discover a provider's models with the same capability resolver used by provider.list. This only
// reads and returns the parsed list; persisting chosen additions is the app's job. Issue #1463.
export const fetchProviderModels = Effect.fn("ProviderHttpApi.models.fetch")(function* (input: {
  providerID: ProviderID
}) {
  const auth = yield* Auth.Service
  const modelsDev = yield* ModelsDev.Service
  const provider = yield* Provider.Service

  const [authInfo, modelsDevProviders, connected] = yield* Effect.all(
    [
      auth.get(input.providerID).pipe(Effect.orElseSucceed(() => undefined)),
      modelsDev.data().pipe(Effect.orElseSucceed(() => ({}) as Record<string, ModelsDev.Provider>)),
      provider.list(),
    ],
    { concurrency: "unbounded" },
  )

  const catalog = withPawWorkProviders(modelsDevProviders)[input.providerID]
  const resolved = resolveModelDiscovery({
    providerID: input.providerID,
    provider: connected[input.providerID],
    catalog,
    auth: authInfo,
  })
  if (!resolved) {
    return { ok: false as const, message: "Model discovery is not supported for this provider" }
  }

  return yield* Effect.promise(async (): Promise<FetchProviderModelsResult> => {
    try {
      const response = await fetch(resolved.endpoint, {
        headers: resolved.headers,
        signal: AbortSignal.timeout(10_000),
      })
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
