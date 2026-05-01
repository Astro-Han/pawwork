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
  const routeMessagesReady = createMemo(() => {
    const id = input.routeSessionID()
    if (!id) return true
    return input.sync.data.message[id] !== undefined
  })

  const sessionView = createSessionViewController({
    directory: input.directory,
    routeSessionID: input.routeSessionID,
    routeMessagesReady,
  })
  const sessionID = sessionView.visible.id
  const sessionKey = sessionView.visible.key
  const sessionInfo = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return input.sync.session.get(id)
  })
  const isChildSession = createMemo(() => !!sessionInfo()?.parentID)
  const messages = createMemo(
    () => {
      const id = sessionID()
      return readSessionMessages(id ? input.sync.data.message[id] : undefined)
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
      () => lastUserMessage()?.id,
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
    sessionID,
    sessionKey,
    sessionInfo,
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
