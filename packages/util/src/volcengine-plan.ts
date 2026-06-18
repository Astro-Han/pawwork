export const VOLCENGINE_PLAN_PROVIDER_ID = "volcengine-plan"
export const VOLCENGINE_PLAN_DEFAULT_MODEL_ID = "doubao-seed-2.0-code"

export const VOLCENGINE_PLAN_VISIBLE_MODEL_IDS = [
  "doubao-seed-2.0-code",
  "doubao-seed-2.0-pro",
  "doubao-seed-2.0-lite",
  "doubao-seed-code",
  "minimax-m2.7",
  "minimax-m3",
  "glm-5.2",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "kimi-k2.6",
] as const

export const VOLCENGINE_PLAN_HIDDEN_MODEL_IDS = ["ark-code-latest"] as const

const VOLCENGINE_PLAN_MODEL_FAMILIES = [
  ["doubao-seed", "doubao-seed"],
  ["minimax", "minimax"],
  ["glm", "glm"],
  ["deepseek", "deepseek"],
  ["kimi", "kimi"],
  ["ark-code", "ark-code"],
] as const

export function volcenginePlanModelFamily(id: string) {
  return VOLCENGINE_PLAN_MODEL_FAMILIES.find(([prefix]) => id === prefix || id.startsWith(`${prefix}-`))?.[1] ?? id
}
