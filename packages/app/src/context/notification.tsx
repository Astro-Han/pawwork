import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { Binary } from "@opencode-ai/util/binary"
import { base64Encode } from "@opencode-ai/util/encode"
import { decode64 } from "@/utils/base64"
import { EventSessionError } from "@opencode-ai/sdk/v2"
import { Persist, persisted } from "@/utils/persist"
import { playSoundById } from "@/utils/sound"
import { workspaceKey } from "@/pages/layout/helpers"
import { badgeSessionCount } from "./notification-derive"
import { pendingRootSessionIDs } from "./global-sync/pending-question-index"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: EventSessionError["properties"]["error"]
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
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

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
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

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
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

export const { use: useNotification, provider: NotificationProvider } = createSimpleContext({
  name: "Notification",
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()

    const empty: Notification[] = []

    const currentDirectory = createMemo(() => {
      return decode64(params.dir)
    })

    const currentSession = createMemo(() => params.id)

    const [store, setStore, _, ready] = persisted(
      Persist.global("notification", ["notification.v1"]),
      createStore({
        list: [] as Notification[],
      }),
    )
    const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

    const meta = { pruned: false, disposed: false }

    const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
      setIndex(scope, "unseen", key, unseen)
      setIndex(scope, "unseenCount", key, unseen.length)
      setIndex(
        scope,
        "unseenHasError",
        key,
        unseen.some((notification) => notification.type === "error"),
      )
    }

    const appendToIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
          setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
          setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
        }
      }
    }

    const removeFromIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
          updateUnseen("session", notification.session, unseen)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
          updateUnseen("project", notification.directory, unseen)
        }
      }
    }

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      meta.pruned = true
      const list = pruneNotifications(store.list)
      batch(() => {
        setStore("list", list)
        setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
      })
    })

    const append = (notification: Notification) => {
      const list = pruneNotifications([...store.list, notification])
      const keep = new Set(list)
      const removed = store.list.filter((n) => !keep.has(n))

      batch(() => {
        if (keep.has(notification)) appendToIndex(notification)
        removed.forEach((n) => removeFromIndex(n))
        setStore("list", list)
      })
    }

    const lookup = async (directory: string, sessionID?: string) => {
      if (!sessionID) return undefined
      const [syncStore] = globalSync.child(directory, { bootstrap: false })
      const match = Binary.search(syncStore.session, sessionID, (s) => s.id)
      if (match.found) return syncStore.session[match.index]
      return globalSDK.client.session
        .get({ directory, sessionID })
        .then((x) => x.data)
        .catch(() => undefined)
    }

    const viewedInCurrentSession = (directory: string, sessionID?: string) => {
      if (typeof document !== "undefined" && !document.hasFocus()) return false
      const activeDirectory = currentDirectory()
      const activeSession = currentSession()
      if (!activeDirectory) return false
      if (!activeSession) return false
      if (!sessionID) return false
      // Normalize before comparing: the event directory and the routed
      // directory can be the same workspace yet differ by a trailing slash or
      // slash direction (notably on Windows), which would otherwise alert for a
      // session the user is already viewing.
      if (workspaceKey(directory) !== workspaceKey(activeDirectory)) return false
      return sessionID === activeSession
    }

    const handleSessionIdle = (directory: string, event: { properties: { sessionID?: string } }, time: number) => {
      const sessionID = event.properties.sessionID
      void lookup(directory, sessionID).then((session) => {
        if (meta.disposed) return
        if (!session) return
        if (session.parentID) return

        const level = settings.notify.level()
        const visible = viewedInCurrentSession(directory, sessionID)
        const shouldAlert = level !== "never" && (level === "always" || !visible)
        if (shouldAlert) {
          void playSoundById("notify")
          const href = `/${base64Encode(directory)}/session/${sessionID}`
          void platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, href)
        }

        append({
          directory,
          time,
          viewed: visible,
          type: "turn-complete",
          session: sessionID,
        })
      })
    }

    const handleSessionError = (
      directory: string,
      event: { properties: { sessionID?: string; error?: EventSessionError["properties"]["error"] } },
      time: number,
    ) => {
      const sessionID = event.properties.sessionID
      void lookup(directory, sessionID).then((session) => {
        if (meta.disposed) return
        if (session?.parentID) return

        const error = "error" in event.properties ? event.properties.error : undefined
        append({
          directory,
          time,
          viewed: viewedInCurrentSession(directory, sessionID),
          type: "error",
          session: sessionID ?? "global",
          error,
        })
        const level = settings.notify.level()
        if (level !== "never") {
          void playSoundById("error")
          const description =
            session?.title ??
            (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))
          const href = sessionID ? `/${base64Encode(directory)}/session/${sessionID}` : `/${base64Encode(directory)}`
          void platform.notify(language.t("notification.session.error.title"), description, href)
        }
      })
    }

    // A live question's OS alert (sound / notification / Dock attention) is
    // driven by the global pending-question controller, which fires exactly once
    // on the rising edge — when a `question` part first becomes ready — and never
    // on hydrate/reconnect, so a restart with an outstanding question does not
    // re-nag. The controller has already resolved the root session it should be
    // attributed to; we only decide whether to surface it and how.
    const alertQuestion = (alert: {
      directory: string
      askSessionID: string
      rootSessionID: string
    }) => {
      if (meta.disposed) return
      const level = settings.notify.level()
      if (level === "never") return
      const visible = viewedInCurrentSession(alert.directory, alert.rootSessionID)
      if (level !== "always" && visible) return

      const [syncStore] = globalSync.child(alert.directory, { bootstrap: false })
      const match = Binary.search(syncStore.session, alert.rootSessionID, (s) => s.id)
      const rootTitle = match.found ? syncStore.session[match.index].title : undefined

      void playSoundById("notify")
      const href = `/${base64Encode(alert.directory)}/session/${alert.rootSessionID}`
      void platform.notify(language.t("notification.question.title"), rootTitle ?? alert.rootSessionID, href)
      // A question blocks the agent on the user, so it bounces the Dock /
      // flashes the taskbar. turn-complete and error only notify.
      void platform.requestAttention?.()
    }

    const markSessionViewed = (session: string) => {
      const unseen = index.session.unseen[session] ?? empty
      if (!unseen.length) return

      const projects = [
        ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
      ]
      batch(() => {
        setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
        updateUnseen("session", session, [])
        projects.forEach((directory) => {
          const next = (index.project.unseen[directory] ?? empty).filter(
            (notification) => notification.session !== session,
          )
          updateUnseen("project", directory, next)
        })
      })
    }

    const unsub = globalSDK.event.listen((e) => {
      const event = e.details
      const directory = e.name

      if (event.type !== "session.idle" && event.type !== "session.error") return

      const time = Date.now()
      if (event.type === "session.idle") {
        handleSessionIdle(directory, event, time)
        return
      }
      handleSessionError(directory, event, time)
    })
    const unsubQuestionAlert = globalSync.onQuestionAlert(alertQuestion)
    onCleanup(() => {
      meta.disposed = true
      unsub()
      unsubQuestionAlert()
    })

    // Dock/taskbar badge: how many sessions are waiting for the user. Two
    // sources unioned by session (see badgeSessionCount): unseen turn-complete /
    // error notifications from *this* app run (launch-scoped so a fresh start
    // shows zero instead of resurfacing the persisted backlog), plus the root
    // sessions of every live pending question (a current condition, so never
    // launch-scoped — a question still outstanding across a restart should
    // badge). Follows the notify level (suppressed when off). macOS/Linux only
    // (platform.setBadgeCount is undefined elsewhere).
    const launchTime = Date.now()
    const badgeCount = createMemo(() =>
      badgeSessionCount(store.list, pendingRootSessionIDs(globalSync.data.pendingQuestions), launchTime),
    )
    createEffect(() => {
      const count = settings.notify.level() === "never" ? 0 : badgeCount()
      void platform.setBadgeCount?.(count)
    })

    // Returning focus to the window should clear the unread dot of the session
    // you're already looking at. Notifications created while the window was
    // blurred (e.g. a turn finishing in the background) land unviewed even for
    // the active route, and route-change is the only other thing that marks
    // them viewed — so without this the dot lingers until you navigate away.
    if (typeof window !== "undefined") {
      makeEventListener(window, "focus", () => {
        const session = currentSession()
        if (session) markSessionViewed(session)
      })
    }

    return {
      ready,
      session: {
        all(session: string) {
          return index.session.all[session] ?? empty
        },
        unseen(session: string) {
          return index.session.unseen[session] ?? empty
        },
        unseenCount(session: string) {
          return index.session.unseenCount[session] ?? 0
        },
        unseenHasError(session: string) {
          return index.session.unseenHasError[session] ?? false
        },
        markViewed: markSessionViewed,
      },
      project: {
        all(directory: string) {
          return index.project.all[directory] ?? empty
        },
        unseen(directory: string) {
          return index.project.unseen[directory] ?? empty
        },
        unseenCount(directory: string) {
          return index.project.unseenCount[directory] ?? 0
        },
        unseenHasError(directory: string) {
          return index.project.unseenHasError[directory] ?? false
        },
        markViewed(directory: string) {
          const unseen = index.project.unseen[directory] ?? empty
          if (!unseen.length) return

          const sessions = [
            ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
            updateUnseen("project", directory, [])
            sessions.forEach((session) => {
              const next = (index.session.unseen[session] ?? empty).filter(
                (notification) => notification.directory !== directory,
              )
              updateUnseen("session", session, next)
            })
          })
        },
      },
    }
  },
})
