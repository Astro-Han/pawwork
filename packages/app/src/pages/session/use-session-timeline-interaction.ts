import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, on, onCleanup } from "solid-js"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import {
  collectTimelineScrollMetrics,
  restoreTimelineSafePosition,
  sampleTimelineSafePosition,
} from "@/pages/session/session-timeline-scroll-anchors"
import { createSessionActiveMessage } from "@/pages/session/use-session-active-message"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createSessionHistoryBackfill } from "@/pages/session/use-session-history-backfill"
import { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"
import {
  createSessionTimelineScrollController,
  type TimelineRecovery,
  type TimelineScrollControllerResult,
  type TimelineScrollIntent,
  type TimelineScrollObservation,
} from "@/pages/session/session-timeline-scroll-controller"

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
  let recoveryFrame: number | undefined
  const createScrollController = () =>
    createSessionTimelineScrollController({
      sessionOwner: input.sessionKey(),
      viewportOwner: `timeline:${input.sessionKey()}`,
      routeSessionID: input.routeSessionID(),
      visibleSessionID: input.sessionID(),
      timelineSessionID: input.sessionID(),
      emitDiagnostic: (event) => {
        void emitRendererDiagnostic(event).catch(() => {})
      },
    })
  let scrollController = createScrollController()

  const cancelRecoveryFrame = () => {
    if (recoveryFrame === undefined) return
    cancelAnimationFrame(recoveryFrame)
    recoveryFrame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.sessionID()] as const,
      () => {
        cancelRecoveryFrame()
        const previous = scrollController.state()
        scrollController.detach({
          sessionOwner: previous.sessionOwner,
          viewportOwner: previous.viewportOwner,
        })
        scrollController = createScrollController()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    cancelRecoveryFrame()
    const owner = scrollController.state()
    scrollController.detach({
      sessionOwner: owner.sessionOwner,
      viewportOwner: owner.viewportOwner,
    })
  })

  let scrollDock!: ReturnType<typeof createSessionScrollDock>
  scrollDock = createSessionScrollDock({
    clearMessageHash: () => clearMessageHash(),
    clearActiveMessage: () => activeMessage?.clearActiveMessage(),
    fill: () => historyBackfill?.fill(),
    onContentResize: () => {
      const viewport = scrollDock.scroller()
      if (!viewport) return
      onTimelineScrollObservation({
        type: "content_resize",
        metrics: collectTimelineScrollMetrics(viewport),
      })
    },
    onDockHeightChange: (event) => {
      const viewport = scrollDock.scroller()
      if (viewport) {
        onTimelineScrollObservation({
          type: "dock_resize",
          dockKind: event.dockKind,
          previousDockHeight: event.previousComposerHeight,
          nextDockHeight: event.composerHeight,
          metrics: collectTimelineScrollMetrics(viewport),
        })
      }
      void emitRendererDiagnostic({
        name: "session.layout.composer_dock",
        route_session_id: input.routeSessionID(),
        visible_session_id: input.sessionID(),
        timeline_session_id: input.sessionID(),
        data: {
          dock_kind: event.dockKind,
          composer_height: event.composerHeight,
          previous_composer_height: event.previousComposerHeight,
          scroll_top: event.scrollTop,
          distance_from_bottom: event.distanceFromBottom,
        },
      })
    },
  })
  const autoScroll = scrollDock.autoScroll
  const lockOwner = () => input.sessionKey()
  const resumeScroll = () => scrollDock.resumeScroll(lockOwner())
  const userScrolledForHistory = () => (scrollDock.bottomFollowLocked(lockOwner()) ? false : autoScroll.userScrolled())

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
    userScrolled: userScrolledForHistory,
    isAtBottom: () => scrollDock.scroll.bottom,
    scroller: scrollDock.scroller,
  })

  const resumeLatest = () => {
    const result = scrollController.intent({ type: "jump_latest", source: "button" })
    historyWindow.resumeLatestWindow()
    applyTimelineRecovery(result.recovery)
  }

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

  const markScrollGesture = (target?: EventTarget | null) => {
    scrollDock.cancelBottomFollowLock()
    activeMessage.markScrollGesture(target)
  }

  const shouldCancelBottomFollowLockForIntent = (intent: TimelineScrollIntent) => {
    if (intent.type === "scrollbar_drag_start" || intent.type === "target_message") return true
    if (intent.type === "layout_interaction") return true
    if (intent.type === "keyboard_scroll") {
      return intent.key === "ArrowUp" || intent.key === "PageUp" || intent.key === "Home"
    }
    if (intent.type === "wheel_scroll" || intent.type === "touch_scroll") {
      // Slice 11b.1 P0 #6 retest — GPT-X RCA: the previous gate only
      // released the bottom-follow lock on upward gestures, so a user
      // who scrolled up and then nudged the wheel downward would still
      // have the 3-second lock armed underneath, and the very next
      // content resize would call `followBottom()` and snap the
      // viewport back. Releasing the lock on every non-nested
      // wheel/touch (regardless of direction) matches the intent
      // signalled by any meaningful user gesture inside the timeline
      // itself. Nested-scrollable gestures (inside a diff or code
      // block) still preserve the lock since they're not directed at
      // the timeline.
      return !intent.nestedScrollable
    }
    return false
  }

  const navigateMessageByOffset = (offset: number) => {
    scrollDock.cancelBottomFollowLock()
    activeMessage.navigateMessageByOffset(offset)
  }

  const applyTimelineRecovery = (recovery: TimelineRecovery) => {
    if (recovery.type === "none") return
    cancelRecoveryFrame()
    const owner = scrollController.state()
    recoveryFrame = requestAnimationFrame(() => {
      recoveryFrame = undefined
      const current = scrollController.state()
      if (current.sessionOwner !== owner.sessionOwner || current.viewportOwner !== owner.viewportOwner) return

      if (recovery.type === "restore_latest") {
        historyWindow.resumeLatestWindow()
        resumeScroll()
        return
      }

      const viewport = scrollDock.scroller()
      const restored = restoreTimelineSafePosition({
        viewport,
        position: recovery.anchor,
      })
      if (restored.ok && viewport) scrollDock.scheduleScrollState(viewport)
    })
  }

  const onTimelineScrollIntent = (intent: TimelineScrollIntent): TimelineScrollControllerResult => {
    if (shouldCancelBottomFollowLockForIntent(intent)) scrollDock.cancelBottomFollowLock()
    // Slice 11b.1 P0 #6 retest 4 (GPT-X RCA msg=d60ff75a): a trow
    // toggle is a user-layout intent — distinct from a scroll gesture
    // but still a "I'm reading here" signal. The controller flips to
    // `reading_history` on the intent itself, but `autoScroll` lives
    // in a parallel owner that does not observe the controller; it
    // needs an explicit `pause()` so the next ResizeObserver tick
    // from the agent's append does not re-snap the viewport to
    // bottom underneath the user.
    if (intent.type === "layout_interaction") autoScroll.pause()
    const result = scrollController.intent(intent)
    applyTimelineRecovery(result.recovery)
    return result
  }

  const onTimelineScrollObservation = (observation: TimelineScrollObservation): TimelineScrollControllerResult => {
    let next = observation
    if (observation.type === "scroll_sample" && !observation.safePosition) {
      const viewport = scrollDock.scroller()
      if (viewport) {
        const controllerState = scrollController.state()
        const targetMessageID =
          controllerState.lastSafePosition.kind === "target_message"
            ? controllerState.lastSafePosition.messageID
            : undefined
        next = {
          ...observation,
          safePosition: sampleTimelineSafePosition({
            viewport,
            mode: controllerState.mode,
            renderedStart: historyWindow.turnStart(),
            renderedCount: historyWindow.renderedUserMessages().length,
            newestMessageID: input.visibleUserMessages().at(-1)?.id,
            targetMessageID,
          }),
        }
      }
    }
    const result = scrollController.observe(next)
    applyTimelineRecovery(result.recovery)
    return result
  }

  const submitLatest = () => {
    const result = scrollController.intent({
      type: "submit",
      originMode: scrollController.state().mode,
    })
    historyWindow.resumeLatestWindow()
    applyTimelineRecovery(result.recovery)
  }

  createEffect(
    on(
      () => [input.sessionID(), input.visibleUserMessages().at(-1)?.id, historyWindow.turnStart()] as const,
      () => {
        scrollDock.restoreBottomIfLocked(lockOwner())
      },
      { defer: true },
    ),
  )

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
    markHashTarget: historyWindow.markHashTarget,
    autoScroll,
    scroller: scrollDock.scroller,
    anchor,
    scheduleScrollState: scrollDock.scheduleScrollState,
    consumePendingMessage: input.consumePendingMessage,
    onMessageNavigation: (messageID) => {
      scrollDock.cancelBottomFollowLock()
      onTimelineScrollIntent({
        type: "target_message",
        messageID,
        align: "nearest",
      })
    },
    onMessageHashCleared: () => historyWindow.clearHashTarget(),
  })
  clearMessageHash = hashScroll.clearMessageHash
  activeMessage.setScrollToMessage(hashScroll.scrollToMessage)

  return {
    activeMessage,
    autoScroll,
    anchor,
    historyWindow,
    resumeScroll: resumeLatest,
    submitLatest,
    scheduleScrollState: scrollDock.scheduleScrollState,
    scrollDock,
    setScrollRef: scrollDock.setScrollRef,
    markScrollGesture,
    navigateMessageByOffset,
    onTimelineScrollIntent,
    onTimelineScrollObservation,
  }
}
