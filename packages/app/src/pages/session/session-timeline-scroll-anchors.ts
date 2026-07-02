import type {
  TimelineSafePosition,
  TimelineScrollMetrics,
  TimelineScrollMode,
} from "./session-timeline-scroll-controller"
import { createTimelineScrollCommandSink, type TimelineScrollCommandSink } from "./timeline-scroll-command-sink"

export type TimelineAnchorRestoreResult =
  | { ok: true; restoredTo: TimelineSafePosition }
  | { ok: false; reason: "anchor_not_mounted" | "viewport_missing" | "invalid_anchor" }

export type TimelineAnchorTopResult =
  | { ok: true; top: number; reason: string }
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

function computeLatestTop(viewport: HTMLElement, bottomSentinel: HTMLElement | null | undefined): TimelineAnchorTopResult {
  if (bottomSentinel) {
    const viewportRect = viewport.getBoundingClientRect()
    const sentinelRect = bottomSentinel.getBoundingClientRect()
    return { ok: true, top: viewport.scrollTop + sentinelRect.bottom - viewportRect.bottom, reason: "bottom-sentinel" }
  }
  return { ok: true, top: viewport.scrollHeight - viewport.clientHeight, reason: "scroll-height-bottom" }
}

function computeReadingTop(
  viewport: HTMLElement,
  position: Extract<TimelineSafePosition, { kind: "reading" }>,
): TimelineAnchorTopResult {
  const anchor = messageElementByID(viewport, position.anchorMessageID)
  if (!anchor) return { ok: false, reason: "anchor_not_mounted" }
  const viewportRect = viewport.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  return {
    ok: true,
    top: viewport.scrollTop + anchorRect.top - viewportRect.top - position.offsetFromViewportTop,
    reason: "reading-anchor",
  }
}

function computeTargetTop(
  viewport: HTMLElement,
  position: Extract<TimelineSafePosition, { kind: "target_message" }>,
): TimelineAnchorTopResult {
  const target = messageElementByID(viewport, position.messageID)
  if (!target) return { ok: false, reason: "anchor_not_mounted" }

  const viewportRect = viewport.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const offset = position.offsetFromViewportTop

  if (typeof offset === "number") {
    return { ok: true, top: viewport.scrollTop + targetRect.top - viewportRect.top - offset, reason: "target-offset" }
  }

  if (position.align === "nearest") {
    // Already fully in view: desired top equals current top so the <1px skip no-ops the write.
    if (targetRect.top >= viewportRect.top && targetRect.bottom <= viewportRect.bottom) {
      return { ok: true, top: viewport.scrollTop, reason: "target-nearest-visible" }
    }
    if (targetRect.top < viewportRect.top) {
      return { ok: true, top: viewport.scrollTop + targetRect.top - viewportRect.top, reason: "target-nearest-top" }
    }
    return { ok: true, top: viewport.scrollTop + targetRect.bottom - viewportRect.bottom, reason: "target-nearest-bottom" }
  }

  if (position.align === "center") {
    const targetHeight = Math.max(0, targetRect.bottom - targetRect.top)
    return {
      ok: true,
      top: viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetHeight) / 2,
      reason: "target-center",
    }
  }

  return { ok: true, top: viewport.scrollTop + targetRect.top - viewportRect.top, reason: "target-start" }
}

/**
 * Pure read pass: computes the desired `scrollTop` for a safe position without
 * writing. Callers (the reconciler) compare against the current scrollTop, apply
 * a min-delta skip, and issue a single sink write — keeping reads before writes.
 */
export function computeTimelineSafePositionTop(args: {
  viewport: HTMLElement | undefined
  position: TimelineSafePosition
  bottomSentinel?: HTMLElement | null
}): TimelineAnchorTopResult {
  if (!args.viewport) return { ok: false, reason: "viewport_missing" }
  if (args.position.kind === "latest") return computeLatestTop(args.viewport, args.bottomSentinel)
  if (args.position.kind === "reading") {
    if (!args.position.anchorMessageID) return { ok: false, reason: "invalid_anchor" }
    return computeReadingTop(args.viewport, args.position)
  }
  if (!args.position.messageID) return { ok: false, reason: "invalid_anchor" }
  return computeTargetTop(args.viewport, args.position)
}

export function restoreTimelineSafePosition(args: {
  viewport: HTMLElement | undefined
  position: TimelineSafePosition
  bottomSentinel?: HTMLElement | null
  scrollCommandSink?: TimelineScrollCommandSink
}): TimelineAnchorRestoreResult {
  const computed = computeTimelineSafePositionTop(args)
  if (!computed.ok) return computed
  const source =
    args.position.kind === "latest"
      ? "session-timeline-scroll-anchors/restoreLatest"
      : args.position.kind === "reading"
        ? "session-timeline-scroll-anchors/restoreReading"
        : "session-timeline-scroll-anchors/restoreTarget"
  setTimelineScrollTop({
    viewport: args.viewport as HTMLElement,
    sink: args.scrollCommandSink ?? fallbackTimelineScrollCommandSink,
    top: computed.top,
    source,
    reason: computed.reason,
  })
  return { ok: true, restoredTo: args.position }
}
