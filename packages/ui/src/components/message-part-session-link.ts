import type { Session } from "@opencode-ai/sdk/v2"
import { taskAgent } from "./message-part-tool-info"

/**
 * Slice 11b.1: routing helpers extracted from `message-part.tsx`.
 *
 *   `sessionLink`     compose an in-app URL to a child session given the
 *                     current route. Falls back to `href(id)` when the
 *                     consumer (e.g. embedded shells) provides a custom
 *                     resolver via `data.sessionHref`.
 *   `currentSession`  parse the parent session id out of the current
 *                     path; used by `taskSession` to scope child lookups.
 *   `taskSession`     resolve a `task` / `agent` tool's spawned child
 *                     session id from the store, matching by description
 *                     prefix and the agent name suffix that
 *                     `process/task.ts` writes into the title.
 *
 * Pure helpers — no Solid reactivity, no JSX. Importable from both the
 * tool dispatcher and individual tool renderers without pulling in the
 * Kobalte / motion side-effects that live in the renderer modules.
 */

export function sessionLink(
  id: string | undefined,
  path: string,
  href?: (id: string) => string | undefined,
) {
  if (!id) return

  const direct = href?.(id)
  if (direct) return direct

  const idx = path.indexOf("/session")
  if (idx === -1) return
  return `${path.slice(0, idx)}/session/${id}`
}

export function currentSession(path: string) {
  return path.match(/\/session\/([^/?#]+)/)?.[1]
}

export function taskSession(
  input: Record<string, any>,
  path: string,
  sessions: Session[] | undefined,
  agents?: readonly { name: string; color?: string }[],
) {
  const parentID = currentSession(path)
  if (!parentID) return
  const description = typeof input.description === "string" ? input.description : ""
  const agent = taskAgent(input.subagent_type, agents).name
  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (agent ? session.title.includes(`@${agent}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}
