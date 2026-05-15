// Tool names are hardcoded here. Canonical definitions live in
// packages/opencode/src/tool/ — if upstream renames a tool, the sanity test
// in session-status-extractors.test.ts catches it by grepping the source file.
//   todowrite → packages/opencode/src/tool/todo.ts
//   webfetch  → packages/opencode/src/tool/webfetch.ts
//   websearch → packages/opencode/src/tool/websearch.ts
//
// Input shape: parts live in sync.data.part[message.id], keyed by messageID.
// Callers pass a pre-flattened Part[] — produced by
//   messages.flatMap((m) => sync.data.part[m.id] ?? [])
// so these extractors stay as pure functions testable against SDK fixtures.

import type { Part } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"

export const TOOL_TODOWRITE = "todowrite"
export const TOOL_WEBFETCH = "webfetch"
export const TOOL_WEBSEARCH = "websearch"

export type TodoItem = Pick<Todo, "content" | "status" | "priority"> & Partial<Pick<Todo, "id">>

function isToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool"
}

function isValidTodo(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false
  const v = value as Partial<TodoItem>
  return (
    (v.id === undefined || typeof v.id === "string") &&
    typeof v.content === "string" &&
    typeof v.status === "string" &&
    typeof v.priority === "string"
  )
}

function todosFromMetadata(part: Extract<Part, { type: "tool" }>): TodoItem[] | undefined {
  const metadata = part.state.status === "completed" ? part.state.metadata : undefined
  const todos = (metadata as { todos?: unknown } | undefined)?.todos
  if (!Array.isArray(todos)) return undefined
  const valid = todos.filter(isValidTodo)
  return valid.length === todos.length ? valid : undefined
}

export function extractTodos(parts: Part[]): TodoItem[] {
  let latest: TodoItem[] = []
  for (const part of parts) {
    if (!isToolPart(part)) continue
    if (part.tool !== TOOL_TODOWRITE) continue
    if (part.state.status !== "completed") continue
    const metadataTodos = todosFromMetadata(part)
    if (metadataTodos) {
      latest = metadataTodos
      continue
    }

    const rawInput = part.state.input
    if (typeof rawInput !== "object" || rawInput === null) continue
    const todos = (rawInput as { todos?: unknown }).todos
    if (!Array.isArray(todos)) continue
    latest = todos.filter(isValidTodo)
  }
  return latest
}

// Allow single-level balanced paren groups (any number of them, but no nesting) so
// links like https://en.wikipedia.org/wiki/Foo_(bar) are captured whole. Unbalanced
// trailing ')' is left out by the branch alternation.
const URL_REGEX = /https?:\/\/(?:\([^()\s]*\)|[^\s<>"'()])+/g
const TRAILING_PUNCT = /[.,;:!?]+$/
const SOURCES_CAP = 20

function normalizeUrl(raw: string): string {
  return raw.replace(TRAILING_PUNCT, "")
}

// Lowercase only scheme + host for the dedupe key; path/query/fragment remain case-sensitive.
// This prevents `HTTPS://Example.COM/p` and `https://example.com/p` from appearing twice.
function dedupeKey(url: string): string {
  return url.replace(/^(https?:\/\/[^/?#]+)/i, (m) => m.toLowerCase())
}

export function extractSources(parts: Part[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const addUrl = (raw: string) => {
    const url = normalizeUrl(raw)
    if (!url) return
    const key = dedupeKey(url)
    if (seen.has(key)) return
    seen.add(key)
    out.push(url)
  }

  for (const part of parts) {
    if (out.length >= SOURCES_CAP) break
    if (!isToolPart(part)) continue
    if (part.state.status !== "completed") continue

    if (part.tool === TOOL_WEBFETCH) {
      const rawInput = part.state.input
      if (typeof rawInput !== "object" || rawInput === null) continue
      const url = (rawInput as { url?: unknown }).url
      if (typeof url === "string") addUrl(url)
      continue
    }

    if (part.tool === TOOL_WEBSEARCH) {
      const output = (part.state as { output?: unknown }).output
      if (typeof output !== "string") continue
      const matches = output.match(URL_REGEX) ?? []
      for (const url of matches) {
        if (out.length >= SOURCES_CAP) break
        addUrl(url)
      }
    }
  }

  return out
}
