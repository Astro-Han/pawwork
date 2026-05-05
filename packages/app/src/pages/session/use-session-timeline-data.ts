import { createEffect, createMemo, on } from "solid-js"
import type { useLocal } from "@/context/local"
import type { useSync } from "@/context/sync"
import { createSessionViewController } from "@/pages/session/session-view-controller"
import {
  emptyMessages,
  emptyUserMessages,
  readSessionMessages,
  readUserMessages,
} from "@/pages/session/session-messages"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { diffs as list } from "@/utils/diffs"
import { same } from "@/utils/same"

type LastGoodMessages =
  | {
      dataIdentity: string
      sessionID: string
      messages: ReturnType<typeof readSessionMessages>
    }
  | undefined

export function readTimelineMessages(input: {
  sessionID: string | undefined
  dataIdentity?: string
  raw: unknown
  lastGood: LastGoodMessages
}): { messages: ReturnType<typeof readSessionMessages>; lastGood: LastGoodMessages } {
  if (!input.sessionID) {
    return { messages: emptyMessages, lastGood: undefined }
  }

  const dataIdentity =
    input.dataIdentity ??
    (input.lastGood?.sessionID === input.sessionID ? input.lastGood.dataIdentity : input.sessionID)

  if (input.raw !== undefined) {
    const messages = readSessionMessages(input.raw)
    return { messages, lastGood: { dataIdentity, sessionID: input.sessionID, messages } }
  }

  if (input.lastGood?.dataIdentity === dataIdentity && input.lastGood.sessionID === input.sessionID) {
    return { messages: input.lastGood.messages, lastGood: input.lastGood }
  }

  return { messages: emptyMessages, lastGood: input.lastGood }
}

export function timelineDataIdentity(input: { sessionID: string | undefined; created: number | undefined }) {
  if (!input.sessionID || input.created === undefined) return
  return `${input.sessionID}:${input.created}`
}

export function timelineModelSyncKey(input: { directory: string; messageID: string | undefined }) {
  return `${input.directory}\n${input.messageID ?? ""}`
}

export function currentSessionCacheReady(input: {
  sessionID: string | undefined
  sessionInfo: unknown
  rawMessages: unknown
}) {
  if (!input.sessionID) return true
  return input.sessionInfo !== undefined && input.rawMessages !== undefined
}

export function currentSessionActionReady(input: {
  sessionID: string | undefined
  sessionInfo: unknown
  rawMessages: unknown
  status: unknown
}) {
  if (!input.sessionID) return true
  return currentSessionCacheReady(input) && input.status !== undefined
}

export function readTimelineMessagesFromCache(input: {
  sessionID: string | undefined
  sessionCreated: number | undefined
  raw: unknown
  lastGood: LastGoodMessages
}) {
  return readTimelineMessages({
    sessionID: input.sessionID,
    dataIdentity: timelineDataIdentity({ sessionID: input.sessionID, created: input.sessionCreated }),
    raw: input.raw,
    lastGood: input.lastGood,
  })
}

export function createSessionTimelineData(input: {
  directory: () => string
  routeSessionID: () => string | undefined
  sync: ReturnType<typeof useSync>
  local: ReturnType<typeof useLocal>
}) {
  const routeInfo = createMemo(() => {
    const id = input.routeSessionID()
    return id ? input.sync.session.get(id) : undefined
  })
  const routeDiffs = createMemo(() => {
    const id = input.routeSessionID()
    return id ? list(input.sync.data.session_diff[id]) : []
  })
  const routeSessionCount = createMemo(() => Math.max(routeInfo()?.summary?.files ?? 0, routeDiffs().length))
  const routeHasSessionReview = createMemo(() => routeSessionCount() > 0)
  // Route readiness is raw cache state. The timeline controller decides when to preserve the mounted view.
  const routeMessagesReady = createMemo(() => {
    const id = input.routeSessionID()
    if (!id) return true
    return input.sync.data.message[id] !== undefined
  })

  const sessionView = createSessionViewController({
    routeSessionID: input.routeSessionID,
    routeMessagesReady,
  })
  const sessionID = sessionView.visible.id
  const sessionKey = sessionView.visible.key
  const transitioning = sessionView.transitioning
  const sessionInfo = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return input.sync.session.get(id)
  })
  const sessionInfoPresent = createMemo(() => {
    const id = sessionID()
    if (!id) return true
    return sessionInfo() !== undefined
  })
  const messageCachePresent = createMemo(() => {
    const id = sessionID()
    if (!id) return true
    return input.sync.data.message[id] !== undefined
  })
  const statusKnown = createMemo(() => {
    const id = sessionID()
    if (!id) return true
    return input.sync.data.session_status[id] !== undefined
  })
  const currentSessionCacheReadyMemo = createMemo(() => {
    const id = sessionID()
    return currentSessionCacheReady({
      sessionID: id,
      sessionInfo: sessionInfo(),
      rawMessages: id ? input.sync.data.message[id] : undefined,
    })
  })
  const actionReady = createMemo(() => {
    const id = sessionID()
    return currentSessionActionReady({
      sessionID: id,
      sessionInfo: sessionInfo(),
      rawMessages: id ? input.sync.data.message[id] : undefined,
      status: id ? input.sync.data.session_status[id] : undefined,
    })
  })
  const isChildSession = createMemo(() => !!sessionInfo()?.parentID)
  // Only reuse last-good messages for a same-session transient cache miss.
  let lastGoodMessages: LastGoodMessages
  const messages = createMemo(
    () => {
      const id = sessionID()
      const next = readTimelineMessagesFromCache({
        sessionID: id,
        sessionCreated: sessionInfo()?.time.created,
        raw: id ? input.sync.data.message[id] : undefined,
        lastGood: lastGoodMessages,
      })
      lastGoodMessages = next.lastGood
      return next.messages
    },
    emptyMessages,
    { equals: same },
  )
  const messagesReady = sessionView.visible.ready
  const diffs = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    return list(input.sync.data.session_diff[id])
  })
  const userMessages = createMemo(() => readUserMessages(messages()), emptyUserMessages, {
    equals: same,
  })
  const revertMessageID = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return input.sync.session.get(id)?.revert?.messageID
  })
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )
  const historyMore = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return input.sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return input.sync.session.history.loading(id)
  })
  const routeHistoryMore = createMemo(() => {
    const id = input.routeSessionID()
    if (!id) return false
    return input.sync.session.history.more(id)
  })
  const routeHistoryLoading = createMemo(() => {
    const id = input.routeSessionID()
    if (!id) return false
    return input.sync.session.history.loading(id)
  })
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(
    on(
      () => timelineModelSyncKey({ directory: input.directory(), messageID: lastUserMessage()?.id }),
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(input.local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: input.directory(), id: input.routeSessionID() }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) input.local.session.reset()
      },
      { defer: true },
    ),
  )

  return {
    routeInfo,
    routeDiffs,
    routeSessionCount,
    routeHasSessionReview,
    routeMessagesReady,
    sessionID,
    sessionKey,
    transitioning,
    sessionInfo,
    sessionInfoPresent,
    messageCachePresent,
    statusKnown,
    currentSessionCacheReady: currentSessionCacheReadyMemo,
    actionReady,
    isChildSession,
    messages,
    messagesReady,
    diffs,
    userMessages,
    revertMessageID,
    visibleUserMessages,
    historyMore,
    historyLoading,
    routeHistoryMore,
    routeHistoryLoading,
    lastUserMessage,
  }
}
