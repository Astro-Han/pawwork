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
 * Number of distinct sessions with unseen notifications created at or after
 * `since`.
 *
 * This is the Dock/taskbar badge number: it counts *sessions* waiting for the
 * user, not the total notification count. One session with three unseen
 * notifications still contributes a single unit, matching how the user reasons
 * about "how many things need me". The `since` cutoff scopes the badge to the
 * current app run — notifications persist across restarts to drive the sidebar,
 * but a fresh launch should show zero on the Dock instead of resurfacing a
 * stale backlog whose sessions the user may have long since dealt with (or that
 * no longer exist). Derived straight from the notification list (the persisted
 * source of truth) so a memo over it tracks reactively.
 */
export function unreadSessionCount(
  notifications: readonly { session?: string; viewed: boolean; time: number }[],
  since = 0,
): number {
  const sessions = new Set<string>()
  for (const notification of notifications) {
    if (!notification.viewed && notification.session && notification.time >= since) {
      sessions.add(notification.session)
    }
  }
  return sessions.size
}

/**
 * Walk a session's parent chain to its root via an injected parent lookup.
 *
 * A child agent's question is surfaced on (and answered from) its root
 * session's page, and only root sessions appear in the sidebar — so a question
 * notification must attribute to the root, not the asking child. `getParentID`
 * is async so the walk can fall back to a network lookup: the global event
 * stream delivers a question even for a background project whose session list
 * was never bootstrapped, where a purely in-memory walk would stop short and
 * mis-attribute the notification to the child. Returns the input id when it has
 * no parent, is unknown, or the chain cycles.
 */
export async function resolveRootSessionIDAsync(
  sessionID: string,
  getParentID: (id: string) => Promise<string | undefined>,
): Promise<string> {
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const parent = await getParentID(current)
    if (!parent) break
    current = parent
  }
  return current
}

/**
 * Resolve a question's root session, then fire its alert — but only if the
 * provider is still mounted and the question is still pending once the async
 * resolution returns.
 *
 * `resolveRoot` may await the network (a background project whose sessions were
 * never bootstrapped), which yields the event loop. In that gap a
 * `message.part.removed` or a terminal `reset` update for the same question can
 * land and clear its dedupe claim — the question is already answered or gone.
 * Re-checking `isPending` after the await (alongside `disposed`) stops a stale
 * alert: an unread dot, badge bump, or Dock bounce for a question that no longer
 * needs the user. `alert` carries the resolved root id and owns the actual
 * notification / sound / attention side effects. Returns the root id when it
 * alerted, or undefined when it bailed.
 */
export async function resolveAndAlertQuestion(opts: {
  resolveRoot: () => Promise<string>
  disposed: () => boolean
  isPending: () => boolean
  alert: (rootID: string) => void
}): Promise<string | undefined> {
  const rootID = await opts.resolveRoot()
  if (opts.disposed()) return undefined
  if (!opts.isPending()) return undefined
  opts.alert(rootID)
  return rootID
}
