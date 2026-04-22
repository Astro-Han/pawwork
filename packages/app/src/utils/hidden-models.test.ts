import { describe, expect, test } from "bun:test"
import { VOLCENGINE_PLAN_HIDDEN_MODEL_IDS, VOLCENGINE_PLAN_PROVIDER_ID } from "@opencode-ai/util/volcengine-plan"
import { filterSystemHiddenModels, isSystemHiddenModel } from "./hidden-models"

describe("isSystemHiddenModel", () => {
  test("hides the Volcano Engine ark-code-latest compatibility alias", () => {
    expect(
      isSystemHiddenModel({ providerID: VOLCENGINE_PLAN_PROVIDER_ID, modelID: VOLCENGINE_PLAN_HIDDEN_MODEL_IDS[0] }),
    ).toBe(true)
  })

  test("does not hide documented Volcano Engine model ids", () => {
    expect(isSystemHiddenModel({ providerID: VOLCENGINE_PLAN_PROVIDER_ID, modelID: "doubao-seed-2.0-code" })).toBe(
      false,
    )
    expect(isSystemHiddenModel({ providerID: VOLCENGINE_PLAN_PROVIDER_ID, modelID: "kimi-k2.6" })).toBe(false)
  })

  test("does not hide latest aliases for unrelated providers", () => {
    expect(isSystemHiddenModel({ providerID: "openai", modelID: "gpt-5-latest" })).toBe(false)
  })

  test("filters hidden compatibility aliases from provider model lists", () => {
    const models = [
      { id: "doubao-seed-2.0-code", name: "Doubao Seed 2.0 Code" },
      { id: "ark-code-latest", name: "Ark Code Latest" },
    ]

    expect(filterSystemHiddenModels(VOLCENGINE_PLAN_PROVIDER_ID, models).map((model) => model.id)).toEqual([
      "doubao-seed-2.0-code",
    ])
  })
})
