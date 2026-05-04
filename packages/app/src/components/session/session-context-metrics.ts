import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"
import {
  contextUsageModelOutputLimit,
  contextUsageUsedTokens,
  deriveContextUsage,
} from "@opencode-ai/util/context-usage"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
    input?: number
    output?: number
  }
}

type Config = {
  compaction?: {
    auto?: boolean
    reserved?: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  effectiveInputLimit: number | undefined
  contextWindow: number | undefined
  compactThreshold: number | undefined
  autoCompactEnabled: boolean
  usedTokens: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usagePercent: number | null
  usage: number | null
}

type Metrics = {
  totalCost: number
  context: Context | undefined
}

const tokenTotal = (msg: AssistantMessage) => {
  return contextUsageUsedTokens(msg.tokens)
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = [], config: Config = {}): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const total = tokenTotal(message)
  const usage = deriveContextUsage({
    model,
    tokens: message.tokens,
    compaction: config.compaction,
    defaultReserveTokens: contextUsageModelOutputLimit(model),
  })

  return {
    totalCost,
    context: {
      message,
      provider,
      model,
      providerLabel: provider?.name ?? message.providerID,
      modelLabel: model?.name ?? message.modelID,
      effectiveInputLimit: usage.effectiveInputLimit,
      contextWindow: model?.limit.context || undefined,
      compactThreshold: usage.compactThreshold,
      autoCompactEnabled: usage.autoCompactEnabled,
      usedTokens: usage.usedTokens,
      input: message.tokens.input,
      output: message.tokens.output,
      reasoning: message.tokens.reasoning,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
      total,
      usagePercent: usage.usagePercent,
      usage: usage.usagePercent === null ? null : Math.round(usage.usagePercent),
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = [], config: Config = {}) {
  return build(messages, providers, config)
}
