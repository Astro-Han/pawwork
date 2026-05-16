import type { ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"

export type ProviderOAuthPrompt = NonNullable<ProviderAuthMethod["prompts"]>[number]
export type ProviderOAuthPromptItem = {
  index: number
  prompt: ProviderOAuthPrompt
}

export function getProviderOAuthSelectPromptState(
  item: ProviderOAuthPromptItem,
  value: { value: string },
  currentValue: Record<string, string>,
) {
  if (item.prompt.type !== "select") return
  return {
    index: item.index,
    value: {
      ...currentValue,
      [item.prompt.key]: value.value,
    },
  }
}
