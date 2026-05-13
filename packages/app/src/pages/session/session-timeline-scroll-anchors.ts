import type { TimelineSafePosition, TimelineScrollMetrics, TimelineScrollMode } from "./session-timeline-scroll-controller"

export type TimelineAnchorRestoreResult =
  | { ok: true; restoredTo: TimelineSafePosition }
  | { ok: false; reason: "anchor_not_mounted" | "viewport_missing" | "invalid_anchor" }

function messageElements(viewport: HTMLElement) {
  return Array.from(viewport.querySelectorAll("[data-message-id]")).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  )
}

function timelineAnchorElements(viewport: HTMLElement) {
  return Array.from(viewport.querySelectorAll("[data-timeline-anchor]")).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.timelineAnchor,
  )
}

function messageElementByID(viewport: HTMLElement, messageID: string) {
  return messageElements(viewport).find((el) => el.dataset.messageId === messageID)
}

function anchorElementByID(viewport: HTMLElement, anchorID: string) {
  return timelineAnchorElements(viewport).find((el) => el.dataset.timelineAnchor === anchorID)
}

function firstVisibleMessage(viewport: HTMLElement) {
  const viewportRect = viewport.getBoundingClientRect()
  for (const el of messageElements(viewport)) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) return { el, rect }
  }
  return undefined
}

function firstVisibleTimelineAnchor(viewport: HTMLElement) {
  const viewportRect = viewport.getBoundingClientRect()
  for (const el of timelineAnchorElements(viewport)) {
    const rect = el.getBoundingClientRect()
    if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) continue
    const anchorID = el.dataset.timelineAnchor
    if (!anchorID) continue
    const owner =
      el.closest("[data-message-id]") instanceof HTMLElement ? (el.closest("[data-message-id]") as HTMLElement) : el
    const messageID = owner.dataset.messageId
    if (!messageID) continue
    return { el, rect, anchorID, messageID }
  }
  return undefined
}

function bottomSentinel(viewport: HTMLElement) {
  const el = viewport.querySelector("[data-timeline-bottom-sentinel]")
  return el instanceof HTMLElement ? el : null
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

  const visibleAnchor = firstVisibleTimelineAnchor(args.viewport)
  if (visibleAnchor) {
    const viewportRect = args.viewport.getBoundingClientRect()
    return {
      kind: "reading",
      anchorID: visibleAnchor.anchorID,
      anchorMessageID: visibleAnchor.messageID,
      offsetFromViewportTop: visibleAnchor.rect.top - viewportRect.top,
      renderedStart: args.renderedStart,
      renderedCount: args.renderedCount,
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

function restoreLatest(viewport: HTMLElement, bottomSentinel?: HTMLElement | null) {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  if (bottomSentinel) {
    const viewportRect = viewport.getBoundingClientRect()
    const sentinelRect = bottomSentinel.getBoundingClientRect()
    const sentinelTop = Math.max(0, viewport.scrollTop + sentinelRect.bottom - viewportRect.bottom)
    viewport.scrollTop = Math.max(sentinelTop, maxScrollTop)
    return
  }
  viewport.scrollTop = maxScrollTop
}

function restoreReading(viewport: HTMLElement, position: Extract<TimelineSafePosition, { kind: "reading" }>) {
  const anchor =
    (position.anchorID ? anchorElementByID(viewport, position.anchorID) : undefined) ??
    messageElementByID(viewport, position.anchorMessageID)
  if (!anchor) return false
  const viewportRect = viewport.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  viewport.scrollTop = Math.max(0, viewport.scrollTop + anchorRect.top - viewportRect.top - position.offsetFromViewportTop)
  return true
}

function restoreTarget(viewport: HTMLElement, position: Extract<TimelineSafePosition, { kind: "target_message" }>) {
  const target = messageElementByID(viewport, position.messageID)
  if (!target) return false

  const viewportRect = viewport.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const offset = position.offsetFromViewportTop

  if (typeof offset === "number") {
    viewport.scrollTop = Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top - offset)
    return true
  }

  if (position.align === "nearest") {
    if (targetRect.top >= viewportRect.top && targetRect.bottom <= viewportRect.bottom) return true
    if (targetRect.top < viewportRect.top) {
      viewport.scrollTop = Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top)
      return true
    }
    viewport.scrollTop = Math.max(0, viewport.scrollTop + targetRect.bottom - viewportRect.bottom)
    return true
  }

  if (position.align === "center") {
    const targetHeight = Math.max(0, targetRect.bottom - targetRect.top)
    viewport.scrollTop = Math.max(
      0,
      viewport.scrollTop + targetRect.top - viewportRect.top - (viewport.clientHeight - targetHeight) / 2,
    )
    return true
  }

  viewport.scrollTop = Math.max(0, viewport.scrollTop + targetRect.top - viewportRect.top)
  return true
}

export function restoreTimelineSafePosition(args: {
  viewport: HTMLElement | undefined
  position: TimelineSafePosition
  bottomSentinel?: HTMLElement | null
}): TimelineAnchorRestoreResult {
  if (!args.viewport) return { ok: false, reason: "viewport_missing" }

  if (args.position.kind === "latest") {
    restoreLatest(args.viewport, args.bottomSentinel ?? bottomSentinel(args.viewport))
    return { ok: true, restoredTo: args.position }
  }

  if (args.position.kind === "reading") {
    if (!args.position.anchorMessageID) return { ok: false, reason: "invalid_anchor" }
    return restoreReading(args.viewport, args.position)
      ? { ok: true, restoredTo: args.position }
      : { ok: false, reason: "anchor_not_mounted" }
  }

  if (!args.position.messageID) return { ok: false, reason: "invalid_anchor" }
  return restoreTarget(args.viewport, args.position)
    ? { ok: true, restoredTo: args.position }
    : { ok: false, reason: "anchor_not_mounted" }
}
