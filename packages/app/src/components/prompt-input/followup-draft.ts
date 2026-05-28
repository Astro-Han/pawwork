import type { ContextItem, Prompt } from "@/context/prompt"

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  locale?: string
  variant?: string
}

export function followupCommandText(draft: FollowupDraft) {
  return draft.prompt.map((part) => ("content" in part ? part.content : "")).join("")
}
