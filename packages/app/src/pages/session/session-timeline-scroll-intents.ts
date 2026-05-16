import type { ScrollViewScrollIntent } from "@opencode-ai/ui/scroll-view"
import { normalizeWheelDelta, shouldMarkBoundaryGesture } from "@/pages/session/message-gesture"
import {
  classifyTimelineScrollGesture,
  type TimelineScrollIntent,
  type TimelineScrollMetrics,
} from "@/pages/session/session-timeline-scroll-controller"

export type TimelineBoundaryGesture = {
  nestedScrollable: boolean
  atNestedBoundary: boolean
}

const scrollMetricThresholds = {
  nearTop: 12,
  nearBottom: 2,
}

export function timelineBoundaryTarget(root: HTMLElement, target: EventTarget | null) {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

export function timelineBoundaryGesture(input: {
  root: HTMLElement
  target: EventTarget | null
  delta: number
}): TimelineBoundaryGesture {
  const target = timelineBoundaryTarget(input.root, input.target)
  if (target === input.root) return { nestedScrollable: false, atNestedBoundary: true }
  return {
    nestedScrollable: true,
    atNestedBoundary: shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    }),
  }
}

export function shouldMarkTimelineBoundaryGesture(boundary: TimelineBoundaryGesture) {
  return !boundary.nestedScrollable || boundary.atNestedBoundary
}

export function scrollViewMetricsToTimelineMetrics(metrics: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): TimelineScrollMetrics {
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  const distanceFromBottom = Math.max(0, max - metrics.scrollTop)
  return {
    scrollTop: metrics.scrollTop,
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
    distanceFromTop: metrics.scrollTop,
    distanceFromBottom,
    nearTop: metrics.scrollTop <= scrollMetricThresholds.nearTop,
    nearBottom: distanceFromBottom <= scrollMetricThresholds.nearBottom,
  }
}

export function scrollViewIntentToTimelineIntent(intent: ScrollViewScrollIntent): TimelineScrollIntent {
  if (intent.type === "keyboard_scroll") {
    return { type: "keyboard_scroll", key: intent.key, source: "scroll_view" }
  }
  return {
    type: intent.type,
    source: "scroll_view",
    metrics: scrollViewMetricsToTimelineMetrics(intent.metrics),
  }
}

export function shouldMarkLegacyScrollIntent(intent: ScrollViewScrollIntent) {
  if (intent.type === "keyboard_scroll") return true
  return intent.type === "scrollbar_drag_start"
}

export type TimelineGestureIntentResult = {
  delta: number
  boundary: TimelineBoundaryGesture
  intent: TimelineScrollIntent
}

export function createWheelTimelineScrollIntent(input: {
  root: HTMLElement
  target: EventTarget | null
  deltaY: number
  deltaMode: number
}): TimelineGestureIntentResult | undefined {
  const delta = normalizeWheelDelta({
    deltaY: input.deltaY,
    deltaMode: input.deltaMode,
    rootHeight: input.root.clientHeight,
  })
  if (!delta) return

  return createPointerTimelineScrollIntent({
    type: "wheel_scroll",
    root: input.root,
    target: input.target,
    delta,
  })
}

export function createTouchTimelineScrollIntent(input: {
  root: HTMLElement
  target: EventTarget | null
  delta: number
}): TimelineGestureIntentResult | undefined {
  if (!input.delta) return
  return createPointerTimelineScrollIntent({
    type: "touch_scroll",
    root: input.root,
    target: input.target,
    delta: input.delta,
  })
}

function createPointerTimelineScrollIntent(input: {
  type: "wheel_scroll" | "touch_scroll"
  root: HTMLElement
  target: EventTarget | null
  delta: number
}): TimelineGestureIntentResult {
  const boundary = timelineBoundaryGesture({
    root: input.root,
    target: input.target,
    delta: input.delta,
  })
  const gesture = classifyTimelineScrollGesture({
    deltaY: input.delta,
    viewportHeight: input.root.clientHeight,
    nestedScrollable: boundary.nestedScrollable,
    atNestedBoundary: boundary.atNestedBoundary,
  })
  return {
    delta: input.delta,
    boundary,
    intent: {
      type: input.type,
      source: "timeline",
      ...gesture,
    },
  }
}
