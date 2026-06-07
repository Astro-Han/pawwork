// Pure derivation helpers for the notification store. Kept separate from the
// reactive context so the badge count and unread index can be unit-tested
// without rendering the provider.

import type { Notification } from "./notification"

export type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

// A persisted entry we still model as an unread signal. Questions used to be
// persisted as `type:"question"` notifications; they are now a live condition
// tracked by the global pending-question index (see #1199). The persistence key
// is unchanged, so a `type:"question"` entry written by an older build can still
// be on disk after upgrade — drop it on load so an already-answered question can
// never strand a sidebar unread dot or Dock badge. New entries are only ever
// `turn-complete` / `error`, so this is purely a one-time migration filter.
export function isLiveNotification(notification: { type: string }): boolean {
  return notification.type === "turn-complete" || notification.type === "error"
}

export function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

export function buildNotificationIndex(list: readonly Notification[]): NotificationIndex {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (!isLiveNotification(notification)) return

    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

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
