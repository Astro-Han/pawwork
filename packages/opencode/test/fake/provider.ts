import { Effect, Layer } from "effect"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ModelID, ProviderID } from "../../src/provider/schema"

export function fakeAutomationProvider(): {
  providerID: ProviderID
  modelID: ModelID
  interface: Provider.Interface
} {
  const providerID = ProviderID.make("openai")
  const modelID = ModelID.make("test-reasoning-model")
  const mdl = ProviderTest.model({
    id: modelID,
    providerID,
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: true,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { id: modelID, url: "https://example.com", npm: "ai-gateway-provider" },
  })
  const info = ProviderTest.info({ id: providerID }, mdl)
  // Sanity check: variants include 'high' so tests can use it.
  void ProviderTransform.variants(mdl)
  const iface: Provider.Interface = {
    list: () => Effect.succeed({ [providerID]: info }),
    getProvider: (id) =>
      id === providerID ? Effect.succeed(info) : Effect.die(new Error(`Unknown provider: ${id}`)),
    getModel: (pId, mId) =>
      pId === providerID && mId === modelID ? Effect.succeed(mdl) : Effect.die(new Error(`Unknown model: ${pId}/${mId}`)),
    getLanguage: () => Effect.die(new Error("getLanguage not configured")),
    closest: (pId) => Effect.succeed(pId === providerID ? { providerID, modelID } : undefined),
    getSmallModel: (pId) => Effect.succeed(pId === providerID ? mdl : undefined),
    defaultModel: () => Effect.succeed({ providerID, modelID }),
  }
  return { providerID, modelID, interface: iface }
}

export namespace ProviderTest {
  export function model(override: Partial<Provider.Model> = {}): Provider.Model {
    const id = override.id ?? ModelID.make("gpt-5.2")
    const providerID = override.providerID ?? ProviderID.make("openai")
    return {
      id,
      providerID,
      name: "Test Model",
      capabilities: {
        toolcall: true,
        attachment: false,
        reasoning: false,
        temperature: true,
        interleaved: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
      api: { id, url: "https://example.com", npm: "@ai-sdk/openai" },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 200_000, output: 10_000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2025-01-01",
      ...override,
    }
  }

  export function info(override: Partial<Provider.Info> = {}, mdl = model()): Provider.Info {
    const id = override.id ?? mdl.providerID
    return {
      id,
      name: "Test Provider",
      source: "config",
      env: [],
      options: {},
      models: { [mdl.id]: mdl },
      ...override,
    }
  }

  export function fake(override: Partial<Provider.Interface> & { model?: Provider.Model; info?: Provider.Info } = {}) {
    const mdl = override.model ?? model()
    const row = override.info ?? info({}, mdl)
    return {
      model: mdl,
      info: row,
      layer: Layer.succeed(
        Provider.Service,
        Provider.Service.of({
          list: Effect.fn("TestProvider.list")(() => Effect.succeed({ [row.id]: row })),
          getProvider: Effect.fn("TestProvider.getProvider")((providerID) => {
            if (providerID === row.id) return Effect.succeed(row)
            return Effect.die(new Error(`Unknown test provider: ${providerID}`))
          }),
          getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
            if (providerID === row.id && modelID === mdl.id) return Effect.succeed(mdl)
            return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
          }),
          getLanguage: Effect.fn("TestProvider.getLanguage")(() =>
            Effect.die(new Error("ProviderTest.getLanguage not configured")),
          ),
          closest: Effect.fn("TestProvider.closest")((providerID) =>
            Effect.succeed(providerID === row.id ? { providerID: row.id, modelID: mdl.id } : undefined),
          ),
          getSmallModel: Effect.fn("TestProvider.getSmallModel")((providerID) =>
            Effect.succeed(providerID === row.id ? mdl : undefined),
          ),
          defaultModel: Effect.fn("TestProvider.defaultModel")(() =>
            Effect.succeed({ providerID: row.id, modelID: mdl.id }),
          ),
          ...override,
        }),
      ),
    }
  }
}
