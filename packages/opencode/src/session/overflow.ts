import type { Config } from "@/config"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  // Honor reserved consistently: subtract from input cap when present, otherwise from context.
  // Upstream's branch dropped reserved in the no-input-cap path; that silently ignores user
  // config like `compaction: { reserved: 50_000 }` for models without an explicit input cap.
  // Use ?? so an explicit 0 input cap is preserved (treating 0 as "no input
  // cap" silently fell back to context, masking model configuration).
  const cap = input.model.limit.input ?? context
  return Math.max(0, cap - reserved)
}

export function isOverflow(input: { cfg: Config.Info; tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
