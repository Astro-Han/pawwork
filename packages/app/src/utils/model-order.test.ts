import { describe, expect, test } from "bun:test"
import { VOLCENGINE_PLAN_VISIBLE_MODEL_IDS } from "@opencode-ai/util/volcengine-plan"
import { compareModelsForDisplay } from "./model-order"

const model = (providerID: string, id: string, name: string) => ({
  id,
  name,
  provider: { id: providerID, name: providerID },
})

describe("compareModelsForDisplay", () => {
  test("keeps Volcano Engine models in documented order", () => {
    const items = [
      model("volcengine-plan", "kimi-k2.6", "Kimi K2.6"),
      model("volcengine-plan", "doubao-seed-2.0-code", "Doubao Seed 2.0 Code"),
      model("volcengine-plan", "glm-5.1", "GLM 5.1"),
    ]

    expect(
      items
        .slice()
        .sort(compareModelsForDisplay)
        .map((item) => item.id),
    ).toEqual([
      VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[0],
      VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[6],
      VOLCENGINE_PLAN_VISIBLE_MODEL_IDS[9],
    ])
  })

  test("keeps alphabetical order for providers without explicit order", () => {
    const items = [model("openai", "b-model", "B Model"), model("openai", "a-model", "A Model")]

    expect(
      items
        .slice()
        .sort(compareModelsForDisplay)
        .map((item) => item.name),
    ).toEqual(["A Model", "B Model"])
  })

  test("uses stable ids when display names are equal", () => {
    const items = [
      model("openrouter", "z-model", "Same Model"),
      model("openai", "b-model", "Same Model"),
      model("openai", "a-model", "Same Model"),
    ]

    expect(
      items
        .slice()
        .sort(compareModelsForDisplay)
        .map((item) => `${item.provider.id}:${item.id}`),
    ).toEqual(["openai:a-model", "openai:b-model", "openrouter:z-model"])
  })
})
