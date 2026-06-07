// Pure derivation helper for the notification store. Kept separate from the
// reactive context so the Dock/taskbar badge count can be unit-tested without
// rendering the provider.

/**
 * Number of distinct sessions to badge on the Dock/taskbar.
 *
 * Counts *sessions* needing the user, not notifications: one session with three
 * unseen notifications is a single unit, matching how the user reasons about
 * "how many things need me". Two sources union by session id:
 *
 *  - persisted turn-complete / error notifications created at or after `since`.
 *    The cutoff scopes them to the current app run so a fresh launch shows zero
 *    instead of resurfacing a stale backlog the user may have long dealt with.
 *  - `pendingRootSessionIDs`: root sessions with a live question awaiting the
 *    user right now. A question is a live condition (not a log), so these are
 *    never `since`-scoped — one still outstanding across a restart should badge.
 */
export function badgeSessionCount(
  notifications: readonly { session?: string; viewed: boolean; time: number }[],
  pendingRootSessionIDs: Iterable<string>,
  since = 0,
): number {
  const sessions = new Set<string>(pendingRootSessionIDs)
  for (const notification of notifications) {
    if (!notification.viewed && notification.session && notification.time >= since) {
      sessions.add(notification.session)
    }
  }
  return sessions.size
}
