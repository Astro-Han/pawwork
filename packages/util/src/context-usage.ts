export type ContextUsageModel = {
  limit: {
    context?: number
    input?: number
    output?: number
  }
}

export type ContextUsageTokens = {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type ContextUsageCompaction = {
  auto?: boolean
  reserved?: number
}

export type ContextUsageInput = {
  model?: ContextUsageModel
  tokens: ContextUsageTokens
  compaction?: ContextUsageCompaction
  defaultReserveTokens?: number
}

export type ContextUsage = {
  usedTokens: number
  effectiveInputLimit: number | undefined
  compactThreshold: number | undefined
  usagePercent: number | null
  autoCompactEnabled: boolean
}

const COMPACTION_BUFFER = 20_000

export function contextUsageUsedTokens(tokens: ContextUsageTokens) {
  // Match overflow accounting: non-zero provider `total` wins; otherwise
  // reasoning is excluded because providers may also report it inside output.
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function contextUsageModelOutputLimit(model?: ContextUsageModel) {
  return model?.limit.output
}

function nonNegativeFinite(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.max(0, value)
}

export function deriveContextUsage(input: ContextUsageInput): ContextUsage {
  const usedTokens = contextUsageUsedTokens(input.tokens)
  const context = input.model?.limit.context
  const autoCompactEnabled = input.compaction?.auto !== false

  if (!context) {
    return {
      usedTokens,
      effectiveInputLimit: undefined,
      compactThreshold: undefined,
      usagePercent: null,
      autoCompactEnabled,
    }
  }

  const effectiveInputLimit = input.model?.limit.input ?? context
  // The caller passes the reserve source tokens. This helper applies the shared
  // 20K cap so runtime and UI cannot drift.
  const fallbackReserve = Math.min(COMPACTION_BUFFER, nonNegativeFinite(input.defaultReserveTokens) ?? COMPACTION_BUFFER)
  const reserved = nonNegativeFinite(input.compaction?.reserved) ?? fallbackReserve
  const compactThreshold = Math.max(0, effectiveInputLimit - reserved)
  const usagePercent = effectiveInputLimit > 0 ? (usedTokens / effectiveInputLimit) * 100 : null

  return {
    usedTokens,
    effectiveInputLimit,
    compactThreshold,
    usagePercent,
    autoCompactEnabled,
  }
}
