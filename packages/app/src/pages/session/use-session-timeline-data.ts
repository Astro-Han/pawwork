import { createEffect, createMemo, on } from "solid-js"
import type { useLocal } from "@/context/local"
import type { useSync } from "@/context/sync"
import { createSessionViewController } from "@/pages/session/session-view-controller"
import type { SessionDiffResponse } from "@opencode-ai/sdk/v2/client"
import {
  emptyMessages,
  emptyUserMessages,
  readSessionMessages,
  readUserMessages,
} from "@/pages/session/session-messages"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { same } from "@/utils/same"
import { makeSessionScope, sameSessionScope, sessionScopeKey, type SessionScope } from "./session-scope"
import { aggregateFiles } from "./session-aggregate-files"
import {
  currentDirectoryProviderUsable,
  currentSessionActionReady,
  currentSessionCacheReady,
  currentSessionSubmitReady,
  currentWorkspaceSubmitReady,
  sessionStatusKnown,
} from "./session-action-readiness"

export { aggregateFiles } from "./session-aggregate-files"

export {
  currentDirectoryProviderUsable,
  currentSessionActionReady,
  currentSessionCacheReady,
  currentSessionSubmitReady,
  currentWorkspaceSubmitReady,
  sessionStatusKnown,
} from "./session-action-readiness"

type LastGoodMessages =
  | {
      dataIdentity: string
      scope: SessionScope
      messages: ReturnType<typeof readSessionMessages>
    }
  | undefined

export function aggregateFileCount(
  aggregate: SessionDiffResponse | undefined,
  revertSummary?: { files: number } | undefined,
) {
  if (revertSummary) return revertSummary.files
  return aggregateFiles(aggregate).length
}

export function readTimelineMessages(input: {
  scope: SessionScope | undefined
  dataIdentity?: string
  raw: unknown
  lastGood: LastGoodMessages
}): { messages: ReturnType<typeof readSessionMessages>; lastGood: LastGoodMessages } {
  if (!input.scope) {
    return { messages: emptyMessages, lastGood: undefined }
  }

  const dataIdentity =
    input.dataIdentity ??
    (sameSessionScope(input.lastGood?.scope, input.scope) && input.lastGood
      ? input.lastGood.dataIdentity
      : sessionScopeKey(input.scope))

  if (input.raw !== undefined) {
    const messages = readSessionMessages(input.raw)
    return { messages, lastGood: { dataIdentity, scope: input.scope, messages } }
  }

  if (input.lastGood?.dataIdentity === dataIdentity && sameSessionScope(input.lastGood.scope, input.scope)) {
    return { messages: input.lastGood.messages, lastGood: input.lastGood }
  }

  return { messages: emptyMessages, lastGood: input.lastGood }
}

export function timelineDataIdentity(input: { scope: SessionScope | undefined; created: number | undefined }) {
  if (!input.scope || input.created === undefined) return
  return `${sessionScopeKey(input.scope)}\n${input.created}`
}

export function timelineModelSyncKey(input: { directory: string; messageID: string | undefined; localReady: boolean }) {
  return `${input.directory}\n${input.messageID ?? ""}\n${input.localReady ? "ready" : "loading"}`
}

export function readTimelineMessagesFromCache(input: {
  scope: SessionScope | undefined
  sessionCreated: number | undefined
  raw: unknown
  lastGood: LastGoodMessages
}) {
  return readTimelineMessages({
    scope: input.scope,
    dataIdentity: timelineDataIdentity({ scope: input.scope, created: input.sessionCreated }),
    raw: input.raw,
    lastGood: input.lastGood,
  })
}

export function createSessionTimelineData(input: {
  serverKey: () => string | undefined
  directory: () => string
  routeSessionID: () => string | undefined
  sync: ReturnType<typeof useSync>
  local: ReturnType<typeof useLocal>
}) {
  const routeScope = createMemo(() =>
    makeSessionScope({ serverKey: input.serverKey(), sessionID: input.routeSessionID() }),
  )
  const routeInfo = createMemo(() => {
    const id = input.routeSessionID()
    return id ? input.sync.session.get(id) : undefined
  })
  const routeAggregate = createMemo(() => {
    const id = input.routeSessionID()
    return id ? input.sync.data.turn_change_aggregate[id] : undefined
  })
  const routeDiffs = createMemo(() => aggregateFiles(routeAggregate()))
  const routeSessionCount = createMemo(() =>
    aggregateFileCount(routeAggregate(), routeInfo()?.revert ? routeInfo()?.summary : undefined),
  )
  const routeHasSessionReview = createMemo(() => routeSessionCount() > 0)
  // Route readiness gates display of the target timeline. A message array without
  // session info is a partially hydrated route and should stay in opening state.
  const routeMessagesReady = createMemo(() => {
    const id = input.routeSessionID()
    if (!id) return true
    return currentSessionCacheReady({
      sessionID: id,
      sessionInfo: routeInfo(),
      rawMessages: input.sync.data.message[id],
    })
  })

  createEffect(() => {
    const id = input.routeSessionID()
    if (!id) return
    if (input.sync.data.turn_change_aggregate[id] !== undefined) return
    void input.sync.session.diff(id)
  })

  const sessionView = createSessionViewController({
    routeSessionID: input.routeSessionID,
    routeScope,
    routeMessagesReady,
  })
  const sessionID = sessionView.visible.id
  const sessionScope = sessionView.visible.scope
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
    return sessionStatusKnown({
      statusState: input.sync.data.session_status_state,
      status: input.sync.data.session_status[id],
    })
  })
  const currentSessionCacheReadyMemo = createMemo(() => {
    const id = sessionID()
    return currentSessionCacheReady({
      sessionID: id,
      sessionInfo: sessionInfo(),
      rawMessages: id ? input.sync.data.message[id] : undefined,
    })
  })
  const sessionActionReady = createMemo(() => {
    const id = sessionID()
    return currentSessionActionReady({
      sessionID: id,
      sessionInfo: sessionInfo(),
      rawMessages: id ? input.sync.data.message[id] : undefined,
      statusReady: statusKnown(),
    })
  })
  const actionReady = createMemo(() => {
    const id = sessionID()
    return currentSessionSubmitReady({
      sessionID: id,
      sessionInfo: sessionInfo(),
      rawMessages: id ? input.sync.data.message[id] : undefined,
      statusReady: statusKnown(),
      localReady: input.local.session.ready(),
      providerUsable: currentDirectoryProviderUsable({
        providerReady: input.sync.data.provider_ready,
        providerCount: input.sync.data.provider.all.length,
      }),
    })
  })
  const workspaceSubmitReady = createMemo(() =>
    currentWorkspaceSubmitReady({
      localReady: input.local.session.ready(),
      providerUsable: currentDirectoryProviderUsable({
        providerReady: input.sync.data.provider_ready,
        providerCount: input.sync.data.provider.all.length,
      }),
    }),
  )
  const isChildSession = createMemo(() => !!sessionInfo()?.parentID)
  // Only reuse last-good messages for a same-session transient cache miss.
  let lastGoodMessages: LastGoodMessages
  const messages = createMemo(
    () => {
      const id = sessionID()
      const next = readTimelineMessagesFromCache({
        scope: sessionScope(),
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
    return aggregateFiles(input.sync.data.turn_change_aggregate[id])
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
      () =>
        timelineModelSyncKey({
          directory: input.directory(),
          messageID: lastUserMessage()?.id,
          localReady: input.local.session.ready(),
        }),
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
    sessionScope,
    sessionID,
    sessionKey,
    transitioning,
    sessionInfo,
    sessionInfoPresent,
    messageCachePresent,
    statusKnown,
    currentSessionCacheReady: currentSessionCacheReadyMemo,
    sessionActionReady,
    actionReady,
    workspaceSubmitReady,
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
