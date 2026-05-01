import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createSessionActiveMessage } from "@/pages/session/use-session-active-message"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createSessionHistoryBackfill } from "@/pages/session/use-session-history-backfill"
import { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"

export function createSessionTimelineInteraction(input: {
  routeSessionID: () => string | undefined
  sessionKey: () => string
  sessionID: () => string | undefined
  messagesReady: () => boolean
  loadedMessages: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  consumePendingMessage: (key: string) => string | undefined
}) {
  const anchor = (id: string) => `message-${id}`
  let clearMessageHash = () => {}
  let activeMessage!: ReturnType<typeof createSessionActiveMessage>
  let historyBackfill: ReturnType<typeof createSessionHistoryBackfill> | undefined

  const scrollDock = createSessionScrollDock({
    clearMessageHash: () => clearMessageHash(),
    clearActiveMessage: () => activeMessage?.clearActiveMessage(),
    fill: () => historyBackfill?.fill(),
  })
  const autoScroll = scrollDock.autoScroll
  const resumeScroll = scrollDock.resumeScroll

  activeMessage = createSessionActiveMessage({
    sessionKey: input.sessionKey,
    visibleUserMessages: input.visibleUserMessages,
    lastUserMessageID: () => input.visibleUserMessages().at(-1)?.id,
    scroller: scrollDock.scroller,
    resumeScroll,
    pauseAutoScroll: autoScroll.pause,
  })

  const historyWindow = createSessionHistoryWindow({
    sessionID: input.sessionID,
    messagesReady: input.messagesReady,
    loaded: input.loadedMessages,
    visibleUserMessages: input.visibleUserMessages,
    historyMore: input.historyMore,
    historyLoading: input.historyLoading,
    loadMore: input.loadMore,
    userScrolled: autoScroll.userScrolled,
    scroller: scrollDock.scroller,
  })

  historyBackfill = createSessionHistoryBackfill({
    routeSessionID: input.routeSessionID,
    sessionID: input.sessionID,
    messagesReady: input.messagesReady,
    historyWindow,
    historyMore: input.historyMore,
    historyLoading: input.historyLoading,
    visibleUserMessagesLength: () => input.visibleUserMessages().length,
    userScrolled: autoScroll.userScrolled,
    scroller: scrollDock.scroller,
  })

  const hashScroll = useSessionHashScroll({
    sessionKey: input.sessionKey,
    sessionID: input.sessionID,
    messagesReady: input.messagesReady,
    visibleUserMessages: input.visibleUserMessages,
    historyMore: input.historyMore,
    historyLoading: input.historyLoading,
    loadMore: input.loadMore,
    turnStart: historyWindow.turnStart,
    currentMessageId: activeMessage.messageId,
    pendingMessage: activeMessage.pendingMessage,
    setPendingMessage: activeMessage.setPendingMessage,
    setActiveMessage: activeMessage.setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: scrollDock.scroller,
    anchor,
    scheduleScrollState: scrollDock.scheduleScrollState,
    consumePendingMessage: input.consumePendingMessage,
  })
  clearMessageHash = hashScroll.clearMessageHash
  activeMessage.setScrollToMessage(hashScroll.scrollToMessage)

  return {
    activeMessage,
    autoScroll,
    anchor,
    historyWindow,
    resumeScroll,
    scheduleScrollState: scrollDock.scheduleScrollState,
    scrollDock,
    setScrollRef: scrollDock.setScrollRef,
  }
}
