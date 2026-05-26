import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
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
import { createTimelineVirtualRows } from "@/pages/session/timeline-virtual-rows"
import { createTimelineVirtualizerBridge } from "@/pages/session/timeline-virtualizer-bridge"
import {
  createTimelineLayoutTransactionCoordinator,
  type TimelineLayoutTransactionKind,
} from "@/pages/session/timeline-layout-transaction"
import { shouldApplyTimelineRecoveryForObservation } from "@/pages/session/timeline-layout-recovery-policy"
import {
  createSessionTimelineScrollController,
  isWeakUpwardTimelineIntent,
  type TimelineRecovery,
  type TimelineScrollControllerResult,
  type TimelineScrollIntent,
  type TimelineScrollObservation,
} from "@/pages/session/session-timeline-scroll-controller"
import { createTimelineScrollCommandSink } from "@/pages/session/timeline-scroll-command-sink"

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
  let historyWindow!: ReturnType<typeof createSessionHistoryWindow>
  let recoveryFrame: number | undefined
  const [layoutTransactionState, setLayoutTransactionState] = createStore({
    active: false,
    transactionID: undefined as string | undefined,
    kind: undefined as TimelineLayoutTransactionKind | undefined,
  })
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
  const scrollCommandSink = createTimelineScrollCommandSink({
    activeTransaction: () =>
      layoutTransactionState.active && layoutTransactionState.transactionID && layoutTransactionState.kind
        ? {
            transactionID: layoutTransactionState.transactionID,
            transactionKind: layoutTransactionState.kind,
          }
        : undefined,
    emitDiagnostic: (event) => {
      void emitRendererDiagnostic(event).catch(() => {})
    },
    fullMetricsEnabled: () => {
      const value = (globalThis as typeof globalThis & { __PW_TIMELINE_SCROLL_FULL_METRICS__?: boolean })
        .__PW_TIMELINE_SCROLL_FULL_METRICS__
      return value === true
    },
    getContext: () => ({
      routeSessionID: input.routeSessionID(),
      visibleSessionID: input.sessionID(),
      timelineSessionID: input.sessionID(),
    }),
  })

  const layoutTransactionCoordinator = createTimelineLayoutTransactionCoordinator({
    scheduleFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    readMode: () => scrollController.state().mode,
    sampleAnchor: () => {
      const viewport = scrollDock.scroller()
      const controllerState = scrollController.state()
      const targetMessageID =
        controllerState.lastSafePosition.kind === "target_message"
          ? controllerState.lastSafePosition.messageID
          : undefined
      if (!viewport) return controllerState.lastSafePosition
      return sampleTimelineSafePosition({
        viewport,
        mode: controllerState.mode,
        renderedStart: historyWindow.turnStart(),
        renderedCount: historyWindow.renderedUserMessages().length,
        newestMessageID: input.visibleUserMessages().at(-1)?.id,
        targetMessageID,
      })
    },
    restoreAnchor: (position, transactionID) => {
      const viewport = scrollDock.scroller()
      const restored = restoreTimelineSafePosition({
        viewport,
        position,
        scrollCommandSink: scrollCommandSink.withTransaction({
          transactionID,
          transactionKind: layoutTransactionState.kind ?? "content-resize",
        }),
      })
      if (restored.ok && viewport) scrollDock.scheduleScrollState(viewport)
      return restored.ok
    },
    restoreLatest: () => false,
    setStableBandActive: (active) => {
      if (!active) setLayoutTransactionState({ active: false, transactionID: undefined, kind: undefined })
    },
    setTransactionState: (state) => {
      if (state.active) {
        setLayoutTransactionState({ active: true, transactionID: state.transactionID, kind: state.kind })
        return
      }
      setLayoutTransactionState({ active: false, transactionID: undefined, kind: undefined })
    },
    emitDiagnostic: (event) => {
      void emitRendererDiagnostic({
        name: "session.timeline.layout_transaction",
        route_session_id: input.routeSessionID(),
        visible_session_id: input.sessionID(),
        timeline_session_id: input.sessionID(),
        monotonic_ms: event.monotonicMs,
        data: {
          transaction_id: event.transactionID,
          transaction_kind: event.kind,
          transaction_phase: event.phase,
          transaction_status: event.violation ? "violation" : undefined,
          mode: event.mode,
          source: event.source,
          reason: event.reason,
          anchor_kind: event.anchorKind,
          anchor_message_id: event.anchorMessageID,
          fallback_frames: event.fallbackFrames,
          violation: event.violation,
        },
      }).catch(() => {})
    },
  })

  const cancelRecoveryFrame = () => {
    if (recoveryFrame === undefined) return
    cancelAnimationFrame(recoveryFrame)
    recoveryFrame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.sessionID()] as const,
      () => {
        layoutTransactionCoordinator.cancel()
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
    layoutTransactionCoordinator.cancel()
    cancelRecoveryFrame()
    const owner = scrollController.state()
    scrollController.detach({
      sessionOwner: owner.sessionOwner,
      viewportOwner: owner.viewportOwner,
    })
  })

  let scrollDock!: ReturnType<typeof createSessionScrollDock>
  const latestProtectionBandPx = 120
  const isLatestProtected = () => {
    const state = scrollController.state()
    return state.mode === "following_latest" && state.latestProtected
  }
  scrollDock = createSessionScrollDock({
    clearMessageHash: () => clearMessageHash(),
    clearActiveMessage: () => activeMessage?.clearActiveMessage(),
    fill: () => historyBackfill?.fill(),
    scrollCommandSink,
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
          layoutTransactionHandled: event.layoutTransactionHandled,
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
    runLayoutTransaction: (event) => {
      layoutTransactionCoordinator.run({
        kind: event.kind,
        source: event.source,
        reason: event.reason,
        mode: event.stickToBottom ? "following_latest" : undefined,
        mutate: event.mutate,
        restoreLatest: event.restoreLatest,
      })
    },
    shouldPreserveLatestForLayoutChange: (event) => {
      const state = scrollController.state()
      if (state.mode === "following_latest") return true
      if (state.latestProtected) return true
      if (scrollDock.bottomFollowLocked(lockOwner())) return true
      return event.metrics.distanceFromBottom <= latestProtectionBandPx
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

  historyWindow = createSessionHistoryWindow({
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
    scrollCommandSink,
  })
  const virtualRows = createMemo(() =>
    createTimelineVirtualRows({
      messages: historyWindow.renderedUserMessages(),
      historyMore: input.historyMore(),
      turnStart: historyWindow.turnStart(),
    }),
  )
  const virtualizerBridge = createTimelineVirtualizerBridge({ rows: virtualRows })

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
    layoutTransactionCoordinator.cancel()
    scrollDock.cancelBottomFollowLock()
    activeMessage.markScrollGesture(target)
  }

  const shouldCancelBottomFollowLockForIntent = (intent: TimelineScrollIntent) => {
    if (isLatestProtected() && isWeakUpwardTimelineIntent(intent)) return false
    if (intent.type === "scrollbar_drag_start" || intent.type === "target_message") return true
    if (intent.type === "keyboard_scroll") {
      return intent.key === "ArrowUp" || intent.key === "PageUp" || intent.key === "Home"
    }
    if (intent.type === "wheel_scroll" || intent.type === "touch_scroll") {
      return intent.direction === "up" && !intent.nestedScrollable
    }
    return false
  }

  const navigateMessageByOffset = (offset: number) => {
    layoutTransactionCoordinator.cancel()
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
        if (current.mode !== "following_latest") return
        resumeScroll()
        return
      }

      const viewport = scrollDock.scroller()
      const restored = restoreTimelineSafePosition({
        viewport,
        position: recovery.anchor,
        scrollCommandSink,
      })
      if (restored.ok && viewport) scrollDock.scheduleScrollState(viewport)
    })
  }

  const onTimelineScrollIntent = (intent: TimelineScrollIntent): TimelineScrollControllerResult => {
    if (shouldCancelBottomFollowLockForIntent(intent)) {
      layoutTransactionCoordinator.cancel()
      scrollDock.cancelBottomFollowLock()
    }
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
    if (
      shouldApplyTimelineRecoveryForObservation({
        layoutTransactionActive: layoutTransactionState.active,
        layoutTransactionHandled:
          "layoutTransactionHandled" in observation ? observation.layoutTransactionHandled : undefined,
        observationType: observation.type,
      })
    ) {
      applyTimelineRecovery(result.recovery)
    }
    return result
  }

  const submitLatest = () => {
    const result = scrollController.intent({
      type: "submit",
      originMode: scrollController.state().mode,
    })
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
    scrollCommandSink,
    virtualizerReveal: ({ messageID, behavior }) =>
      virtualizerBridge.scrollMessageNearTop({
        messageID,
        behavior,
        viewport: scrollDock.scroller(),
        sink: scrollCommandSink,
        source: "use-session-timeline-interaction/virtualizerReveal",
        reason: "hash-target-not-mounted",
      }),
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
    virtualizerBridge,
    resumeScroll: resumeLatest,
    submitLatest,
    scheduleScrollState: scrollDock.scheduleScrollState,
    scrollDock,
    layoutTransactionActive: () => layoutTransactionState.active,
    layoutTransactionID: () => layoutTransactionState.transactionID,
    layoutTransactionKind: () => layoutTransactionState.kind,
    setScrollRef: scrollDock.setScrollRef,
    markScrollGesture,
    navigateMessageByOffset,
    onTimelineScrollIntent,
    onTimelineScrollObservation,
  }
}
