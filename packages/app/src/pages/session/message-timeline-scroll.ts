import type { ScrollViewScrollIntent } from "@opencode-ai/ui/scroll-view"
import { shouldMarkBoundaryGesture } from "@/pages/session/message-gesture"
import type {
  TimelineScrollIntent,
  TimelineScrollMetrics,
} from "@/pages/session/session-timeline-scroll-controller"

/**
 * Slice 11b.1: scroll-routing helpers extracted from `message-timeline.tsx`
 * per design doc §3b.
 *
 *   `boundaryTarget`       find the nearest nested scrollable inside the
 *                          timeline viewport, or fall back to the root.
 *   `boundaryGesture`      classify whether a wheel/touch delta is at
 *                          the nested scrollable's boundary (and so the
 *                          gesture should propagate to the timeline).
 *   `markBoundaryGesture`  call-site convenience: only forward the
 *                          gesture to the timeline when it's at the
 *                          nested boundary or the root scroll itself.
 *   `scrollViewMetrics…`   translate ScrollView intent metrics into the
 *                          shape the timeline scroll controller expects.
 *   `scrollViewIntent…`    translate ScrollView intent shapes into the
 *                          timeline scroll intent shape.
 *   `shouldMarkLegacyScrollIntent`
 *                          keyboard scrolls + drag-start are still
 *                          marked through the legacy `onMarkScrollGesture`
 *                          path to preserve the existing focus-restore
 *                          semantics; this predicate isolates that rule.
 */

export function boundaryTarget(root: HTMLElement, target: EventTarget | null) {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

export function boundaryGesture(input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
}) {
  const target = boundaryTarget(input.root, input.target)
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

export function markBoundaryGesture(input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) {
  const boundary = boundaryGesture(input)
  if (!boundary.nestedScrollable || boundary.atNestedBoundary) {
    input.onMarkScrollGesture(input.root)
  }
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
    nearTop: metrics.scrollTop <= 12,
    nearBottom: distanceFromBottom <= 2,
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
