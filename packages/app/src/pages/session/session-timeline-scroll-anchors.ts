import type {
  TimelineSafePosition,
  TimelineScrollMetrics,
  TimelineScrollMode,
} from "./session-timeline-scroll-controller"
import { createTimelineScrollCommandSink, type TimelineScrollCommandSink } from "./timeline-scroll-command-sink"

export type TimelineAnchorRestoreResult =
  | { ok: true; restoredTo: TimelineSafePosition }
  | { ok: false; reason: "anchor_not_mounted" | "viewport_missing" | "invalid_anchor" }

function messageElements(viewport: HTMLElement) {
  return Array.from(viewport.querySelectorAll("[data-message-id]")).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  )
}

function messageElementByID(viewport: HTMLElement, messageID: string) {
  return messageElements(viewport).find((el) => el.dataset.messageId === messageID)
}

function firstVisibleMessage(viewport: HTMLElement) {
  const viewportRect = viewport.getBoundingClientRect()
  for (const el of messageElements(viewport)) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) return { el, rect }
  }
  return undefined
}

const fallbackTimelineScrollCommandSink = createTimelineScrollCommandSink()

function setTimelineScrollTop(input: {
  viewport: HTMLElement
  top: number
  sink: TimelineScrollCommandSink
  source: string
  reason: string
}) {
  input.sink.setScrollTop({
    element: input.viewport,
    top: Math.max(0, input.top),
    type: "anchor-restore",
    source: input.source,
    reason: input.reason,
  })
}

export function collectTimelineScrollMetrics(viewport: HTMLElement): TimelineScrollMetrics {
  const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const distanceFromBottom = Math.max(0, max - viewport.scrollTop)
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    distanceFromTop: viewport.scrollTop,
    distanceFromBottom,
    nearTop: viewport.scrollTop <= 12,
    nearBottom: distanceFromBottom <= 2,
  }
}

export function sampleTimelineSafePosition(args: {
  viewport: HTMLElement
  mode: TimelineScrollMode
  renderedStart: number
  renderedCount: number
  newestMessageID?: string
  targetMessageID?: string
}): TimelineSafePosition {
  if (args.mode === "following_latest") return { kind: "latest", messageID: args.newestMessageID }
  if (args.mode === "targeting_message" && args.targetMessageID) {
    return {
      kind: "target_message",
      messageID: args.targetMessageID,
      align: "nearest",
      loadPolicy: "load_until_visible",
    }
  }

  const visible = firstVisibleMessage(args.viewport)
  const messageID = visible?.el.dataset.messageId
  if (!visible || !messageID) return { kind: "latest", messageID: args.newestMessageID }

  const viewportRect = args.viewport.getBoundingClientRect()
  return {
    kind: "reading",
    anchorMessageID: messageID,
    offsetFromViewportTop: visible.rect.top - viewportRect.top,
    renderedStart: args.renderedStart,
    renderedCount: args.renderedCount,
  }
}

function restoreLatest(
  viewport: HTMLElement,
  bottomSentinel: HTMLElement | null | undefined,
  sink: TimelineScrollCommandSink,
) {
  if (bottomSentinel) {
    const viewportRect = viewport.getBoundingClientRect()
    const sentinelRect = bottomSentinel.getBoundingClientRect()
    setTimelineScrollTop({
      viewport,
      sink,
      top: viewport.scrollTop + sentinelRect.bottom - viewportRect.bottom,
      source: "session-timeline-scroll-anchors/restoreLatest",
      reason: "bottom-sentinel",
    })
    return
  }
  setTimelineScrollTop({
    viewport,
    sink,
    top: viewport.scrollHeight - viewport.clientHeight,
    source: "session-timeline-scroll-anchors/restoreLatest",
    reason: "scroll-height-bottom",
  })
}

function restoreReading(
  viewport: HTMLElement,
  position: Extract<TimelineSafePosition, { kind: "reading" }>,
  sink: TimelineScrollCommandSink,
) {
  const anchor = messageElementByID(viewport, position.anchorMessageID)
  if (!anchor) return false
  const viewportRect = viewport.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  setTimelineScrollTop({
    viewport,
    sink,
    top: viewport.scrollTop + anchorRect.top - viewportRect.top - position.offsetFromViewportTop,
    source: "session-timeline-scroll-anchors/restoreReading",
    reason: "reading-anchor",
  })
  return true
}

function restoreTarget(
  viewport: HTMLElement,
  position: Extract<TimelineSafePosition, { kind: "target_message" }>,
  sink: TimelineScrollCommandSink,
) {
  const target = messageElementByID(viewport, position.messageID)
  if (!target) return false

  const viewportRect = viewport.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const offset = position.offsetFromViewportTop

  if (typeof offset === "number") {
    setTimelineScrollTop({
      viewport,
      sink,
      top: viewport.scrollTop + targetRect.top - viewportRect.top - offset,
      source: "session-timeline-scroll-anchors/restoreTarget",
      reason: "target-offset",
    })
    return true
  }

  if (position.align === "nearest") {
    if (targetRect.top >= viewportRect.top && targetRect.bottom <= viewportRect.bottom) return true
    if (targetRect.top < viewportRect.top) {
      setTimelineScrollTop({
        viewport,
        sink,
        top: viewport.scrollTop + targetRect.top - viewportRect.top,
        source: "session-timeline-scroll-anchors/restoreTarget",
        reason: "target-nearest-top",
      })
      return true
    }
    setTimelineScrollTop({
      viewport,
      sink,
      top: viewport.scrollTop + targetRect.bottom - viewportRect.bottom,
      source: "session-timeline-scroll-anchors/restoreTarget",
      reason: "target-nearest-bottom",
    })
    return true
  }

  if (position.align === "center") {
    const targetHeight = Math.max(0, targetRect.bottom - targetRect.top)
    setTimelineScrollTop({
      viewport,
      sink,
      top: viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetHeight) / 2,
      source: "session-timeline-scroll-anchors/restoreTarget",
      reason: "target-center",
    })
    return true
  }

  setTimelineScrollTop({
    viewport,
    sink,
    top: viewport.scrollTop + targetRect.top - viewportRect.top,
    source: "session-timeline-scroll-anchors/restoreTarget",
    reason: "target-start",
  })
  return true
}

export function restoreTimelineSafePosition(args: {
  viewport: HTMLElement | undefined
  position: TimelineSafePosition
  bottomSentinel?: HTMLElement | null
  scrollCommandSink?: TimelineScrollCommandSink
}): TimelineAnchorRestoreResult {
  if (!args.viewport) return { ok: false, reason: "viewport_missing" }
  const sink = args.scrollCommandSink ?? fallbackTimelineScrollCommandSink

  if (args.position.kind === "latest") {
    restoreLatest(args.viewport, args.bottomSentinel, sink)
    return { ok: true, restoredTo: args.position }
  }

  if (args.position.kind === "reading") {
    if (!args.position.anchorMessageID) return { ok: false, reason: "invalid_anchor" }
    return restoreReading(args.viewport, args.position, sink)
      ? { ok: true, restoredTo: args.position }
      : { ok: false, reason: "anchor_not_mounted" }
  }

  if (!args.position.messageID) return { ok: false, reason: "invalid_anchor" }
  return restoreTarget(args.viewport, args.position, sink)
    ? { ok: true, restoredTo: args.position }
    : { ok: false, reason: "anchor_not_mounted" }
}
