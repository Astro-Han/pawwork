import { VOLCENGINE_PLAN_PROVIDER_ID, VOLCENGINE_PLAN_VISIBLE_MODEL_IDS } from "@opencode-ai/util/volcengine-plan"

type DisplayModel = {
  id: string
  name: string
  provider: { id: string }
}

const providerModelOrder: Record<string, string[]> = {
  [VOLCENGINE_PLAN_PROVIDER_ID]: [...VOLCENGINE_PLAN_VISIBLE_MODEL_IDS],
}

export function compareModelsForDisplay(a: DisplayModel, b: DisplayModel) {
  if (a.provider.id === b.provider.id) {
    const order = providerModelOrder[a.provider.id]
    if (order) {
      const aIndex = order.indexOf(a.id)
      const bIndex = order.indexOf(b.id)
      if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex
      if (aIndex >= 0) return -1
      if (bIndex >= 0) return 1
    }
  }
  const byName = a.name.localeCompare(b.name)
  if (byName !== 0) return byName
  const byProvider = a.provider.id.localeCompare(b.provider.id)
  if (byProvider !== 0) return byProvider
  return a.id.localeCompare(b.id)
}
