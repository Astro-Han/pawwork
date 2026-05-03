import type { Config } from "@/config"
import type { Provider } from "@/provider"
import { contextUsageDefaultOutputReserve, deriveContextUsage } from "@opencode-ai/util/context-usage"
import type { MessageV2 } from "./message-v2"

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    deriveContextUsage({
      model: input.model,
      tokens: emptyTokens,
      compaction: input.cfg.compaction,
      defaultOutputReserve: contextUsageDefaultOutputReserve(input.model),
    }).compactThreshold ?? 0
  )
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const usage = deriveContextUsage({
    model: input.model,
    tokens: input.tokens,
    compaction: input.cfg.compaction,
    defaultOutputReserve: contextUsageDefaultOutputReserve(input.model),
  })
  return usage.compactThreshold !== undefined && usage.usedTokens >= usage.compactThreshold
}

const emptyTokens: MessageV2.Assistant["tokens"] = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: {
    read: 0,
    write: 0,
  },
}
