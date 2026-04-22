import { VOLCENGINE_PLAN_HIDDEN_MODEL_IDS, VOLCENGINE_PLAN_PROVIDER_ID } from "@opencode-ai/util/volcengine-plan"

export type HiddenModelKey = {
  providerID: string
  modelID: string
}

const SYSTEM_HIDDEN_MODELS: HiddenModelKey[] = VOLCENGINE_PLAN_HIDDEN_MODEL_IDS.map((modelID) => ({
  providerID: VOLCENGINE_PLAN_PROVIDER_ID,
  modelID,
}))

const systemHiddenModels = new Set(SYSTEM_HIDDEN_MODELS.map((model) => `${model.providerID}:${model.modelID}`))

export function isSystemHiddenModel(model: HiddenModelKey) {
  return systemHiddenModels.has(`${model.providerID}:${model.modelID}`)
}

export function filterSystemHiddenModels<T extends { id: string }>(providerID: string, models: T[]) {
  return models.filter((model) => !isSystemHiddenModel({ providerID, modelID: model.id }))
}
