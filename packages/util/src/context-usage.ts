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
  defaultOutputReserve?: number
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
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

export function contextUsageDefaultOutputReserve(model?: ContextUsageModel) {
  return model?.limit.output || undefined
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
  const reserved =
    input.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, input.defaultOutputReserve ?? COMPACTION_BUFFER)
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
