import type {
  TimelineReadingAnchor,
  TimelineReadingAnchorScope,
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

const READING_LINE_OFFSET_PX = 100
const MIN_VISIBLE_ANCHOR_INTERSECTION_PX = 2

function timelineAnchorElements(viewport: HTMLElement) {
  return Array.from(viewport.querySelectorAll("[data-timeline-anchor]")).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  )
}

function timelineAnchorScope(key: string): TimelineReadingAnchorScope {
  if (key.startsWith("tool:")) return "tool"
  if (key.startsWith("trow:")) return "trow"
  return "message"
}

function isElementHidden(el: HTMLElement) {
  if (el.hidden) return true
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  return style?.display === "none" || style?.visibility === "hidden"
}

function isInsideClosedDetailsBody(el: HTMLElement) {
  let current: HTMLElement | null = el
  while (current) {
    const parent = current.parentElement
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      return current.tagName.toLowerCase() !== "summary"
    }
    current = current.parentElement
  }
  return false
}

function visibleIntersectionPx(rect: DOMRect, viewportRect: DOMRect) {
  return Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top))
}

function isTimelineAnchorUsableForRestore(el: HTMLElement, rect: DOMRect) {
  if (!el.dataset.timelineAnchor) return false
  if (isElementHidden(el)) return false
  if (isInsideClosedDetailsBody(el)) return false
  if (rect.width <= 0 || rect.height <= 0) return false
  return true
}

function isTimelineAnchorVisibleForSampling(el: HTMLElement, rect: DOMRect, viewportRect: DOMRect) {
  if (!isTimelineAnchorUsableForRestore(el, rect)) return false
  return visibleIntersectionPx(rect, viewportRect) >= MIN_VISIBLE_ANCHOR_INTERSECTION_PX
}

function messageElementForAnchor(el: HTMLElement) {
  const message = el.closest("[data-message-id]")
  return message instanceof HTMLElement ? message : undefined
}

function timelineAnchorByKey(viewport: HTMLElement, key: string) {
  return timelineAnchorElements(viewport).find((el) => el.dataset.timelineAnchor === key)
}

function makeReadingAnchor(el: HTMLElement, rect: DOMRect, viewportRect: DOMRect): TimelineReadingAnchor | undefined {
  const key = el.dataset.timelineAnchor
  if (!key) return undefined
  return {
    key,
    offsetFromViewportTop: rect.top - viewportRect.top,
    scope: timelineAnchorScope(key),
  }
}

function findFallbackTrowAnchor(input: {
  viewport: HTMLElement
  selected: HTMLElement
  selectedKey: string
  viewportRect: DOMRect
}) {
  const message = messageElementForAnchor(input.selected)
  if (!message) return undefined
  const selectedBlock = input.selected.closest('[data-component="session-turn-trow-block"]')
  const scopes = selectedBlock instanceof HTMLElement ? [selectedBlock, message] : [message]
  for (const scope of scopes) {
    const anchor = findFirstVisibleTrowAnchor({
      scope,
      selectedKey: input.selectedKey,
      viewportRect: input.viewportRect,
    })
    if (anchor) return anchor
  }
}

function findFirstVisibleTrowAnchor(input: { scope: HTMLElement; selectedKey: string; viewportRect: DOMRect }) {
  for (const candidate of timelineAnchorElements(input.scope)) {
    const key = candidate.dataset.timelineAnchor
    if (!key || key === input.selectedKey || !key.startsWith("trow:")) continue
    const rect = candidate.getBoundingClientRect()
    if (!isTimelineAnchorVisibleForSampling(candidate, rect, input.viewportRect)) continue
    const anchor = makeReadingAnchor(candidate, rect, input.viewportRect)
    if (anchor) return anchor
  }
}

function bestVisibleTimelineAnchor(viewport: HTMLElement) {
  const viewportRect = viewport.getBoundingClientRect()
  const readingLine = viewportRect.top + READING_LINE_OFFSET_PX
  const candidates = timelineAnchorElements(viewport)
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter(({ el, rect }) => isTimelineAnchorVisibleForSampling(el, rect, viewportRect))

  candidates.sort((a, b) => {
    const aDistance = Math.abs(a.rect.top - readingLine)
    const bDistance = Math.abs(b.rect.top - readingLine)
    if (aDistance !== bDistance) return aDistance - bDistance
    return a.rect.top - b.rect.top
  })

  const selected = candidates[0]
  if (!selected) return undefined
  const primaryAnchor = makeReadingAnchor(selected.el, selected.rect, viewportRect)
  if (!primaryAnchor) return undefined
  const message = messageElementForAnchor(selected.el)
  const messageID = message?.dataset.messageId
  if (!message || !messageID) return undefined
  const messageRect = message.getBoundingClientRect()
  return {
    primaryAnchor,
    fallbackTrowAnchor:
      primaryAnchor.scope === "tool"
        ? findFallbackTrowAnchor({
            viewport,
            selected: selected.el,
            selectedKey: primaryAnchor.key,
            viewportRect,
          })
        : undefined,
    fallbackMessage: {
      messageID,
      offsetFromViewportTop: messageRect.top - viewportRect.top,
    },
  }
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
  const timelineAnchor = bestVisibleTimelineAnchor(args.viewport)
  if (timelineAnchor) {
    return {
      kind: "reading",
      anchorMessageID: timelineAnchor.fallbackMessage.messageID,
      offsetFromViewportTop: timelineAnchor.primaryAnchor.offsetFromViewportTop,
      renderedStart: args.renderedStart,
      renderedCount: args.renderedCount,
      primaryAnchor: timelineAnchor.primaryAnchor,
      fallbackTrowAnchor: timelineAnchor.fallbackTrowAnchor,
      fallbackMessage: timelineAnchor.fallbackMessage,
    }
  }

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
  const viewportRect = viewport.getBoundingClientRect()
  const timelineAnchors = [position.primaryAnchor, position.fallbackTrowAnchor].filter(
    (anchor): anchor is TimelineReadingAnchor => !!anchor,
  )

  for (const timelineAnchor of timelineAnchors) {
    const anchor = timelineAnchorByKey(viewport, timelineAnchor.key)
    if (!anchor) continue
    const anchorRect = anchor.getBoundingClientRect()
    if (!isTimelineAnchorUsableForRestore(anchor, anchorRect)) continue
    setTimelineScrollTop({
      viewport,
      sink,
      top: viewport.scrollTop + anchorRect.top - viewportRect.top - timelineAnchor.offsetFromViewportTop,
      source: "session-timeline-scroll-anchors/restoreReading",
      reason: "reading-timeline-anchor",
    })
    return true
  }

  const fallbackMessageID = position.fallbackMessage?.messageID ?? position.anchorMessageID
  const fallbackOffset = position.fallbackMessage?.offsetFromViewportTop ?? position.offsetFromViewportTop
  const anchor = messageElementByID(viewport, fallbackMessageID)
  if (!anchor) return false
  const anchorRect = anchor.getBoundingClientRect()
  setTimelineScrollTop({
    viewport,
    sink,
    top: viewport.scrollTop + anchorRect.top - viewportRect.top - fallbackOffset,
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
