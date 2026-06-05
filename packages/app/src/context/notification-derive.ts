// Pure derivation helpers for the notification store. Kept separate from the
// reactive context so the badge count and question attribution logic can be
// unit-tested without rendering the provider.

import type { Part } from "@opencode-ai/sdk/v2/client"

type QuestionNotificationPart = Pick<Part, "type"> & {
  tool?: string
  state?: {
    status?: string
    metadata?: {
      externalResultReady?: unknown
    }
  }
}

export function questionCallKey(directory: string, sessionID: string, partID: string) {
  return `${directory}:${sessionID}:${partID}`
}

/**
 * Decide what a `message.part.updated` event means for a question notification.
 *
 * Question parts stream many updates; the external-result input controls only
 * become usable once the engine flips `metadata.externalResultReady`. We notify
 * exactly once on that transition, and `reset` clears the per-call dedupe entry
 * when the part is no longer running (terminal updates may not be followed by a
 * `message.part.removed`).
 */
export function questionNotificationAction(part: QuestionNotificationPart): "ignore" | "reset" | "notify" {
  if (part.type !== "tool" || part.tool !== "question") return "ignore"
  if (part.state?.status !== "running") return "reset"
  if (part.state.metadata?.externalResultReady !== true) return "ignore"
  return "notify"
}

/**
 * Number of distinct sessions that currently have unseen notifications.
 *
 * This is the Dock/taskbar badge number: it counts *sessions* waiting for the
 * user, not the total notification count. One session with three unseen
 * notifications still contributes a single unit, matching how the user reasons
 * about "how many things need me". Derived straight from the notification list
 * (the persisted source of truth) so a memo over it tracks reactively.
 */
export function unreadSessionCount(notifications: readonly { session?: string; viewed: boolean }[]): number {
  const sessions = new Set<string>()
  for (const notification of notifications) {
    if (!notification.viewed && notification.session) sessions.add(notification.session)
  }
  return sessions.size
}

/**
 * Walk a session's parent chain to its root.
 *
 * A child agent's question is surfaced on (and answered from) its root
 * session's page, and only root sessions appear in the sidebar — so a question
 * notification must attribute to the root, not the asking child. Returns the
 * input id unchanged when the session has no parent or is unknown to `sessions`.
 */
export function resolveRootSessionID(
  sessions: readonly { id: string; parentID?: string }[],
  sessionID: string,
): string {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const parent = byID.get(current)?.parentID
    if (!parent) break
    current = parent
  }
  return current
}
