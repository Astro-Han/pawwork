import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { VOLCENGINE_PLAN_PROVIDER_ID } from "@opencode-ai/util/volcengine-plan"
import { compareModelsForDisplay } from "@/utils/model-order"
import type { useProviders } from "@/hooks/use-providers"

let findProviderModel: typeof import("./models").findProviderModel
let listAvailableProviderModels: typeof import("./models").listAvailableProviderModels
let listProviderModels: typeof import("./models").listProviderModels
let createModelsView: typeof import("./models").createModelsView

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))

  const mod = await import("./models")
  findProviderModel = mod.findProviderModel
  listAvailableProviderModels = mod.listAvailableProviderModels
  listProviderModels = mod.listProviderModels
  createModelsView = mod.createModelsView
})

// A providers scope with just the connected models the test cares about — the
// only thing createModelsView reads. Models carry no release_date so they stay
// visible by default (release memo treats them as undated).
function fakeProviders(connected: Array<{ providerID: string; modelID: string }>): ReturnType<typeof useProviders> {
  const byProvider = new Map<string, { id: string; models: Record<string, { id: string; name: string; release_date: string }> }>()
  for (const m of connected) {
    const p = byProvider.get(m.providerID) ?? { id: m.providerID, models: {} }
    p.models[m.modelID] = { id: m.modelID, name: m.modelID, release_date: "" }
    byProvider.set(m.providerID, p)
  }
  const list = [...byProvider.values()]
  return {
    all: () => list,
    default: () => ({}),
    popular: () => [],
    connected: () => list,
    paid: () => [],
  } as unknown as ReturnType<typeof useProviders>
}

const provider = {
  id: VOLCENGINE_PLAN_PROVIDER_ID,
  models: {
    "doubao-seed-2.0-code": { id: "doubao-seed-2.0-code", name: "Doubao Seed 2.0 Code" },
    "glm-5.1": { id: "glm-5.1", name: "GLM 5.1" },
    "kimi-k2.6": { id: "kimi-k2.6", name: "Kimi K2.6" },
    "ark-code-latest": { id: "ark-code-latest", name: "Ark Code Latest" },
  },
}

describe("provider model list helpers", () => {
  test("hides the Volcano Engine latest alias from context model lists", () => {
    expect(listAvailableProviderModels(provider).map((model) => model.id)).toEqual([
      "doubao-seed-2.0-code",
      "glm-5.1",
      "kimi-k2.6",
    ])
  })

  test("keeps the Volcano Engine latest alias resolvable for existing selections", () => {
    expect(listProviderModels(provider).map((model) => model.id)).toEqual([
      "doubao-seed-2.0-code",
      "glm-5.1",
      "kimi-k2.6",
      "ark-code-latest",
    ])
    expect(
      findProviderModel([provider], { providerID: VOLCENGINE_PLAN_PROVIDER_ID, modelID: "ark-code-latest" })?.id,
    ).toBe("ark-code-latest")
  })

  test("passes only visible Volcano Engine models to UI display ordering", () => {
    const visible = listAvailableProviderModels(provider)
      .map((model) => ({ ...model, provider: { id: provider.id } }))
      .sort(compareModelsForDisplay)

    expect(visible.map((model) => model.id)).toEqual(["doubao-seed-2.0-code", "glm-5.1", "kimi-k2.6"])
  })
})

describe("createModelsView scopes to the providers it is given", () => {
  // The #950 PR7 P1 fix: the Automations create card builds its model view from
  // the *selected* directory's providers (via useScopedModels), not the route's.
  // The load-bearing property is that the view only ever reflects the providers
  // handed to it — so swapping the scope swaps the models, defaults and lookups.
  test("list and find reflect the scoped providers, not another scope's", () => {
    createRoot((dispose) => {
      const noHidden = () => new Map<string, "show" | "hide">()
      const viewA = createModelsView(fakeProviders([{ providerID: "alpha", modelID: "a-1" }]), noHidden)
      const viewB = createModelsView(fakeProviders([{ providerID: "bravo", modelID: "b-1" }]), noHidden)

      expect(viewA.list().map((m) => m.id)).toEqual(["a-1"])
      expect(viewB.list().map((m) => m.id)).toEqual(["b-1"])

      expect(viewA.find({ providerID: "alpha", modelID: "a-1" })?.id).toBe("a-1")
      // A model that belongs to the other scope must not resolve here.
      expect(viewA.find({ providerID: "bravo", modelID: "b-1" })).toBeUndefined()
      expect(viewB.find({ providerID: "bravo", modelID: "b-1" })?.id).toBe("b-1")

      dispose()
    })
  })

  test("visible honours the shared visibility map", () => {
    createRoot((dispose) => {
      const hidden = () => new Map<string, "show" | "hide">([["alpha:a-1", "hide"]])
      const view = createModelsView(
        fakeProviders([
          { providerID: "alpha", modelID: "a-1" },
          { providerID: "alpha", modelID: "a-2" },
        ]),
        hidden,
      )

      expect(view.visible({ providerID: "alpha", modelID: "a-1" })).toBe(false)
      // Undated, no explicit pref → visible by default.
      expect(view.visible({ providerID: "alpha", modelID: "a-2" })).toBe(true)

      dispose()
    })
  })
})
