import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"
import {
  contextUsageModelOutputLimit,
  contextUsageUsedTokens,
  deriveContextUsage,
} from "@opencode-ai/util/context-usage"
import { buildTurnMessagesByUserID } from "@/pages/session/session-messages"

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
  total: number
  usagePercent: number | null
  usage: number | null
}

type RecentTurnCache = {
  input: number
  read: number
  write: number
  hitRate: number | null
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

const cacheHitRate = (input: number, read: number, write: number) => {
  // No read and no write means the provider reported no cache activity at all — show nothing.
  // A write-only turn (cold start) keeps read at 0 and still resolves to 0.0%, so the
  // first expensive turn is not hidden behind an empty cell.
  if (read + write <= 0) return null
  const denominator = input + read + write
  if (denominator <= 0) return null
  return Math.round((read / denominator) * 1000) / 10
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
      total,
      usagePercent: usage.usagePercent,
      usage: usage.usagePercent === null ? null : Math.round(usage.usagePercent),
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = [], config: Config = {}) {
  return build(messages, providers, config)
}

// The visible window is every message before the reverted one. Slice by array position rather than
// comparing message ids: the prompt API lets a caller supply a custom message id
// (session/prompt.ts uses `input.messageID ?? MessageID.ascending()`), so id string order is not a
// reliable boundary. The synced messages array is already in turn order, which is the ordering the
// turn grouping below relies on anyway.
function visibleMessagesBeforeRevert(messages: Message[], revertID?: string): Message[] {
  if (!revertID) return messages
  const index = messages.findIndex((message) => message.id === revertID)
  return index >= 0 ? messages.slice(0, index) : messages
}

// Cache hit rate is a per-turn flow metric, not a window-state snapshot, so it is computed
// separately from the context block above. We sum tokensCumulative (per-step totals the backend
// accumulates) across every assistant message of the most recent turn, grouped by parentID — the
// user message that triggered them. message.tokens only keeps the last step's snapshot, which
// hides the cold-start step's writes; tokensCumulative is the whole turn. Compaction summary
// messages are skipped so an auto-compaction never masquerades as the user's latest turn, and
// reverted turns are excluded so a rolled-back session does not report a turn the user no longer sees.
export function getRecentTurnCache(messages: Message[] = [], revertID?: string): RecentTurnCache | null {
  const visible = visibleMessagesBeforeRevert(messages, revertID)
  const turns = buildTurnMessagesByUserID(visible)

  let recentTurnID: string | undefined
  for (let i = visible.length - 1; i >= 0; i--) {
    const message = visible[i]
    if (message.role !== "assistant" || message.summary || !message.parentID || !turns.has(message.parentID)) continue
    recentTurnID = message.parentID
    break
  }
  if (!recentTurnID) return null

  let input = 0
  let read = 0
  let write = 0
  for (const assistant of turns.get(recentTurnID) ?? []) {
    if (assistant.summary) continue
    const tokens = assistant.tokensCumulative
    if (!tokens) continue
    input += tokens.input
    read += tokens.cache.read
    write += tokens.cache.write
  }
  if (read + write <= 0) return null

  return { input, read, write, hitRate: cacheHitRate(input, read, write) }
}

// Session-wide cache: the same tokensCumulative tally as getRecentTurnCache, but summed across every
// visible turn instead of only the latest. Pairing the two lets the panel show "this turn" beside the
// running session rate without a scope toggle. Summary and reverted turns are excluded for the same
// reasons as the per-turn metric, so the session figure only reflects turns the user still sees.
export function getSessionCacheAggregate(messages: Message[] = [], revertID?: string): RecentTurnCache | null {
  const visible = visibleMessagesBeforeRevert(messages, revertID)
  const turns = buildTurnMessagesByUserID(visible)

  let input = 0
  let read = 0
  let write = 0
  for (const assistants of turns.values()) {
    for (const assistant of assistants) {
      if (assistant.summary) continue
      const tokens = assistant.tokensCumulative
      if (!tokens) continue
      input += tokens.input
      read += tokens.cache.read
      write += tokens.cache.write
    }
  }
  if (read + write <= 0) return null

  return { input, read, write, hitRate: cacheHitRate(input, read, write) }
}
