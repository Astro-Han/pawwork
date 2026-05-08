import type { PromptHistoryEntry, PromptHistoryStoredEntry } from "./history"

export interface PromptStore {
  popover: "at" | "slash" | null
  historyIndex: number
  savedPrompt: PromptHistoryEntry | null
  placeholder: number
  draggingType: "image" | "@mention" | null
  mode: "normal" | "shell"
  applyingHistory: boolean
}

export interface HistoryStore {
  entries: PromptHistoryStoredEntry[]
}
