import type { Part, Todo } from "@opencode-ai/sdk/v2"
import { extractTodos } from "@/pages/session/session-status-extractors"

export type SessionTodoSource = {
  backend?: Todo[]
  parts: Part[]
}

export function selectSessionTodos(input: SessionTodoSource & { fallback?: SessionTodoSource }): Todo[] {
  if (input.backend && input.backend.length > 0) return input.backend

  const fromParts = extractTodos(input.parts)
  if (fromParts.length > 0) return fromParts as Todo[]

  if (input.fallback?.backend && input.fallback.backend.length > 0) return input.fallback.backend
  return extractTodos(input.fallback?.parts ?? []) as Todo[]
}
