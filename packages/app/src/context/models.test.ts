import { beforeAll, describe, expect, mock, test } from "bun:test"
import { VOLCENGINE_PLAN_PROVIDER_ID } from "@opencode-ai/util/volcengine-plan"
import { compareModelsForDisplay } from "@/utils/model-order"

let findProviderModel: typeof import("./models").findProviderModel
let listAvailableProviderModels: typeof import("./models").listAvailableProviderModels
let listProviderModels: typeof import("./models").listProviderModels

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))

  const mod = await import("./models")
  findProviderModel = mod.findProviderModel
  listAvailableProviderModels = mod.listAvailableProviderModels
  listProviderModels = mod.listProviderModels
})

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
