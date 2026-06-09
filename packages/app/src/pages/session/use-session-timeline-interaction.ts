import type { UserMessage } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import {
  collectTimelineScrollMetrics,
  sampleTimelineSafePosition,
} from "@/pages/session/session-timeline-scroll-anchors"
import { createSessionActiveMessage } from "@/pages/session/use-session-active-message"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createSessionHistoryBackfill } from "@/pages/session/use-session-history-backfill"
import { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"
import { createTimelineVirtualRows } from "@/pages/session/timeline-virtual-rows"
import { chooseTimelineRowRenderMode } from "@/pages/session/timeline-virtualization-strategy"
import { createTimelineVirtualizerBridge } from "@/pages/session/timeline-virtualizer-bridge"
import { createTimelineScrollReconciler } from "@/pages/session/timeline-scroll-reconciler"
import { handleTimelineScrollObservation } from "@/pages/session/timeline-scroll-observation"
import {
  createSessionTimelineScrollController,
  type TimelineSafePosition,
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
  let scrollDock!: ReturnType<typeof createSessionScrollDock>
  let virtualizerBridge!: ReturnType<typeof createTimelineVirtualizerBridge>
  const [reconcilerActive, setReconcilerActive] = createSignal(false)

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

  const sampleAnchor = (): TimelineSafePosition => {
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
  }

  const reconciler = createTimelineScrollReconciler({
    viewport: () => scrollDock.scroller(),
    scrollCommandSink,
    resolveAnchor: () => scrollController.state().lastSafePosition,
    setActive: setReconcilerActive,
    requestReveal: (position) => {
      const messageID =
        position.kind === "reading"
          ? position.anchorMessageID
          : position.kind === "target_message"
            ? position.messageID
            : undefined
      if (!messageID) return
      virtualizerBridge.scrollMessageNearTop({
        messageID,
        viewport: scrollDock.scroller(),
        behavior: "auto",
        sink: scrollCommandSink,
        source: "use-session-timeline-interaction/reconcilerReveal",
        reason: "anchor-not-mounted",
      })
    },
    emitDiagnostic: (diagnostic) => {
      void emitRendererDiagnostic({
        name: "session.timeline.reconcile",
        route_session_id: input.routeSessionID(),
        visible_session_id: input.sessionID(),
        timeline_session_id: input.sessionID(),
        data: {
          reason: diagnostic.reason,
          outcome: diagnostic.outcome,
          anchor_kind: diagnostic.anchorKind,
          anchor_message_id: diagnostic.anchorMessageID,
          reveal_attempts: diagnostic.revealAttempts,
          delta: diagnostic.delta,
        },
      }).catch(() => {})
    },
  })

  createEffect(
    on(
      () => [input.sessionKey(), input.sessionID()] as const,
      () => {
        reconciler.cancel()
        const previous = scrollController.state()
        scrollController.detach({ sessionOwner: previous.sessionOwner, viewportOwner: previous.viewportOwner })
        scrollController = createScrollController()
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    reconciler.cancel()
    const owner = scrollController.state()
    scrollController.detach({ sessionOwner: owner.sessionOwner, viewportOwner: owner.viewportOwner })
  })

  scrollDock = createSessionScrollDock({
    fill: () => historyBackfill?.fill(),
    onContentResize: () => {
      const viewport = scrollDock.scroller()
      if (!viewport) return
      scrollController.observe({ type: "content_resize", metrics: collectTimelineScrollMetrics(viewport) })
      reconciler.markDirty("content-resize")
    },
    onDockHeightChange: (event) => {
      const viewport = scrollDock.scroller()
      if (viewport) {
        scrollController.observe({
          type: "dock_resize",
          dockKind: event.dockKind,
          previousDockHeight: event.previousComposerHeight,
          nextDockHeight: event.composerHeight,
          metrics: collectTimelineScrollMetrics(viewport),
        })
        reconciler.markDirty("dock-resize")
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

  const userScrolledForHistory = () => scrollController.state().mode !== "following_latest"

  // Resume following the latest output: jump-to-latest intent + reconcile.
  const resumeScroll = () => {
    scrollController.intent({ type: "jump_latest", source: "submit" })
    historyWindow.resumeLatestWindow()
    reconciler.markDirty("intent")
  }

  // Pause auto-follow before navigating to a specific message (cancels any
  // in-flight latest re-pin; the subsequent target intent takes over synchronously).
  const pauseFollow = () => reconciler.cancel()

  activeMessage = createSessionActiveMessage({
    sessionKey: input.sessionKey,
    visibleUserMessages: input.visibleUserMessages,
    lastUserMessageID: () => input.visibleUserMessages().at(-1)?.id,
    scroller: scrollDock.scroller,
    resumeScroll,
    pauseAutoScroll: pauseFollow,
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
    preserveAnchor: (mutate) => {
      // Prepend (older history loaded at the top). In the virtualized list,
      // virtua's shift=true already keeps the reading position by absorbing the
      // prepended height as an internal offset — an app-level write here would
      // fight it and is expensive (anchor rect walk + widened overscan). Let
      // virtua own it. In plain mode there is no virtualizer, so compensate with
      // the cheap scrollHeight delta.
      if (chooseTimelineRowRenderMode({ rowCount: virtualRows().length }) === "virtualized") {
        mutate()
        return
      }
      reconciler.preserveByHeightDelta(mutate)
    },
  })
  const virtualRows = createMemo(() =>
    createTimelineVirtualRows({
      messages: historyWindow.renderedUserMessages(),
      historyMore: input.historyMore(),
      turnStart: historyWindow.turnStart(),
    }),
  )
  virtualizerBridge = createTimelineVirtualizerBridge({ rows: virtualRows })

  const resumeLatest = () => {
    scrollController.intent({ type: "jump_latest", source: "button" })
    historyWindow.resumeLatestWindow()
    reconciler.markDirty("intent")
  }

  historyBackfill = createSessionHistoryBackfill({
    routeSessionID: input.routeSessionID,
    sessionID: input.sessionID,
    messagesReady: input.messagesReady,
    historyWindow,
    historyMore: input.historyMore,
    historyLoading: input.historyLoading,
    visibleUserMessagesLength: () => input.visibleUserMessages().length,
    userScrolled: userScrolledForHistory,
    scroller: scrollDock.scroller,
  })

  const markScrollGesture = (target?: EventTarget | null) => {
    activeMessage.markScrollGesture(target)
  }

  const navigateMessageByOffset = (offset: number) => {
    activeMessage.navigateMessageByOffset(offset)
  }

  // Selecting text in the timeline while following should stop the auto-follow
  // so the selection does not get yanked to the bottom by streaming content.
  // Sample the reading anchor immediately — text selection does not produce a
  // scroll event, so the normal observe(scroll_sample) path would not run and
  // lastSafePosition would remain `latest`.
  const onTimelineInteraction = () => {
    if (scrollController.state().mode !== "following_latest") return
    const selection = typeof window === "undefined" ? null : window.getSelection()
    if (!selection || selection.toString().length === 0) return
    const viewport = scrollDock.scroller()
    if (!viewport) return
    // Only pause follow when the selection actually lives inside the timeline.
    // A selection left over in the composer or sidebar must not stop auto-follow
    // just because the user clicked back into the timeline.
    if (!viewport.contains(selection.anchorNode) || !viewport.contains(selection.focusNode)) return
    onTimelineScrollIntent({
      type: "scrollbar_drag_start",
      source: "scroll_view",
      metrics: collectTimelineScrollMetrics(viewport),
    })
    scrollController.observe({
      type: "scroll_sample",
      metrics: collectTimelineScrollMetrics(viewport),
      safePosition: sampleAnchor(),
    })
  }

  const onTimelineScrollIntent = (intent: TimelineScrollIntent): TimelineScrollControllerResult => {
    const before = scrollController.state().mode
    const result = scrollController.intent(intent)
    // Leaving follow mode via a user gesture drops the latest highlight + hash.
    if (before === "following_latest" && result.mode === "reading_history") {
      activeMessage.clearActiveMessage()
      clearMessageHash()
    }
    if (result.anchorChanged) reconciler.markDirty("intent")
    return result
  }

  const onTimelineScrollObservation = (observation: TimelineScrollObservation): TimelineScrollControllerResult => {
    return handleTimelineScrollObservation({
      observation,
      viewport: scrollDock.scroller(),
      sampleAnchor,
      observe: (next) => scrollController.observe(next),
      restoreNow: (reason, position) => reconciler.restoreNow(reason, position),
    })
  }

  const submitLatest = () => {
    scrollController.intent({ type: "submit", originMode: scrollController.state().mode })
    reconciler.markDirty("intent")
  }

  // New turns / window shifts re-pin the current anchor. In following_latest
  // mode this scrolls the viewport to keep the newest output visible. In
  // reading mode the virtualizer's shift compensation already keeps the reading
  // position stable, so a reconciler flush would fight virtua's own correction.
  createEffect(
    on(
      () => [input.sessionID(), input.visibleUserMessages().at(-1)?.id, historyWindow.turnStart()] as const,
      () => {
        if (scrollController.state().mode === "reading_history") return
        reconciler.markDirty("frame-changed")
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
    autoScroll: {
      pause: pauseFollow,
      forceScrollToBottom: resumeScroll,
    },
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
      // Explicit hash / message navigation enters targeting mode so later layout
      // changes re-pin the target through the reconciler, but it must NOT markDirty
      // here: the hash scroller owns the initial reveal + scrollTo (keeping smooth
      // behavior and the sticky-title inset), and a reconciler pin on this frame
      // would be a second, competing final writer racing that scroll. Once the
      // target is settled in view, computeTargetTop no-ops, so the reconciler
      // simply defers to where the hash scroller placed it.
      scrollController.intent({ type: "target_message", messageID, align: "nearest" })
    },
    onMessageHashCleared: () => historyWindow.clearHashTarget(),
  })
  clearMessageHash = hashScroll.clearMessageHash
  activeMessage.setScrollToMessage(hashScroll.scrollToMessage)

  return {
    activeMessage,
    anchor,
    historyWindow,
    virtualizerBridge,
    resumeScroll: resumeLatest,
    submitLatest,
    scheduleScrollState: scrollDock.scheduleScrollState,
    scrollDock,
    reconcilerActive,
    setScrollRef: scrollDock.setScrollRef,
    markScrollGesture,
    navigateMessageByOffset,
    onTimelineInteraction,
    onTimelineScrollIntent,
    onTimelineScrollObservation,
  }
}
