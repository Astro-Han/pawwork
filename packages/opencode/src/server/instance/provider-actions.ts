import { Effect } from "effect"
import { mapValues } from "remeda"
import { Config } from "../../config/config"
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
