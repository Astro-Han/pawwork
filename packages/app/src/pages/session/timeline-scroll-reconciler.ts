import { computeTimelineSafePositionTop } from "./session-timeline-scroll-anchors"
import type { TimelineSafePosition } from "./session-timeline-scroll-controller"
import type { TimelineScrollCommandSink, TimelineScrollCommandType } from "./timeline-scroll-command-sink"

/**
 * The single app-level authoritative writer for the session timeline viewport.
 *
 * The reducer (scroll controller) decides *what the anchor should be*; this
 * reconciler makes the viewport match that anchor. Every layout change
 * (content/dock resize, history prepend, frame change) is a `markDirty` that
 * triggers one coalesced, read-before-write `flush`. The browser and virtua may
 * compensate internally; the reconciler corrects on the trailing frame so there
 * is exactly one authoritative final position per frame.
 */
export type TimelineReconcileReason =
  | "anchor-changed"
  | "content-resize"
  | "dock-resize"
  | "history-prepend"
  | "frame-changed"
  | "intent"
  | "reveal-retry"

export type TimelineReconcileOutcome =
  | "pinned" // wrote a new scrollTop
  | "noop" // already within minDelta of the anchor, or nothing to pin
  | "pending-reveal" // anchor not mounted, reveal requested, will retry next frame
  | "exhausted" // reveal budget spent; kept current scrollTop and emitted a diagnostic
  | "cancelled" // viewport missing / generation changed

export type TimelineReconcilerDiagnostic = {
  reason: TimelineReconcileReason
  outcome: TimelineReconcileOutcome
  anchorKind: TimelineSafePosition["kind"]
  anchorMessageID?: string
  revealAttempts: number
  delta?: number
}

const RECONCILER_COMMAND_TYPE: Record<TimelineSafePosition["kind"], TimelineScrollCommandType> = {
  latest: "bottom-follow",
  reading: "anchor-restore",
  target_message: "target-message",
}

function anchorMessageID(position: TimelineSafePosition): string | undefined {
  if (position.kind === "reading") return position.anchorMessageID
  return position.messageID
}

export type TimelineScrollReconciler = {
  /** Mark the viewport dirty after a layout change; coalesced into one flush per frame. */
  markDirty: (reason: TimelineReconcileReason) => void
  /** Capture the current anchor, run a layout mutation, then re-pin to the captured anchor. */
  withAnchorSnapshot: (reason: TimelineReconcileReason, mutate: () => void) => void
  /** Run the coalesced reconcile pass now (normally scheduled). Returns the outcome. */
  flush: () => TimelineReconcileOutcome
  /** True while a reconcile is dirty or awaiting a reveal — drives virtualizer overscan. */
  active: () => boolean
  /** Cancel any pending flush and clear in-flight reveal state (e.g. on session switch). */
  cancel: () => void
}

export function createTimelineScrollReconciler(input: {
  viewport: () => HTMLElement | undefined
  scrollCommandSink: TimelineScrollCommandSink
  /** The anchor to re-pin to on a normal flush — the stored, pre-change anchor. */
  resolveAnchor: () => TimelineSafePosition
  /**
   * A fresh anchor sample for withAnchorSnapshot, captured *before* a known
   * layout mutation (e.g. history prepend). Defaults to resolveAnchor.
   */
  sampleAnchor?: () => TimelineSafePosition
  bottomSentinel?: () => HTMLElement | null | undefined
  requestReveal?: (position: TimelineSafePosition) => void
  scheduleFrame?: (callback: () => void) => number
  cancelFrame?: (handle: number) => void
  setActive?: (active: boolean) => void
  emitDiagnostic?: (diagnostic: TimelineReconcilerDiagnostic) => void
  minDeltaPx?: number
  revealBudget?: number
}): TimelineScrollReconciler {
  const scheduleFrame = input.scheduleFrame ?? ((callback) => requestAnimationFrame(callback))
  const cancelFrame = input.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))
  const minDelta = input.minDeltaPx ?? 1
  const revealBudget = input.revealBudget ?? 4

  let generation = 0
  let frameHandle: number | undefined
  let dirty = false
  let active = false
  let revealAttempts = 0
  let snapshot: TimelineSafePosition | undefined
  let pendingReason: TimelineReconcileReason = "intent"

  const setActive = (next: boolean) => {
    if (active === next) return
    active = next
    input.setActive?.(next)
  }

  const settle = (
    outcome: TimelineReconcileOutcome,
    reason: TimelineReconcileReason,
    position: TimelineSafePosition,
    delta?: number,
  ): TimelineReconcileOutcome => {
    // Capture the attempt count before clearing it — the diagnostic must report
    // how many reveal retries this anchor needed, not the post-reset 0.
    const attempts = revealAttempts
    dirty = false
    snapshot = undefined
    revealAttempts = 0
    setActive(false)
    input.emitDiagnostic?.({
      reason,
      outcome,
      anchorKind: position.kind,
      anchorMessageID: anchorMessageID(position),
      revealAttempts: attempts,
      delta,
    })
    return outcome
  }

  const scheduleFlush = () => {
    if (frameHandle !== undefined) return
    const scheduledGeneration = generation
    frameHandle = scheduleFrame(() => {
      frameHandle = undefined
      if (scheduledGeneration !== generation) return
      flush()
    })
  }

  const flush = (): TimelineReconcileOutcome => {
    if (frameHandle !== undefined) {
      cancelFrame(frameHandle)
      frameHandle = undefined
    }
    const reason = pendingReason
    const position = snapshot ?? input.resolveAnchor()
    const viewport = input.viewport()
    if (!viewport) return settle("cancelled", reason, position)

    // Read pass first: compute the desired top, then decide whether to write.
    const computed = computeTimelineSafePositionTop({
      viewport,
      position,
      bottomSentinel: input.bottomSentinel?.(),
    })

    if (computed.ok) {
      const top = Math.max(0, computed.top)
      const delta = Math.abs(top - viewport.scrollTop)
      if (delta < minDelta) return settle("noop", reason, position, delta)
      input.scrollCommandSink.setScrollTop({
        element: viewport,
        top,
        type: RECONCILER_COMMAND_TYPE[position.kind],
        source: `timeline-scroll-reconciler/${position.kind}`,
        reason: computed.reason,
      })
      return settle("pinned", reason, position, delta)
    }

    if (computed.reason === "anchor_not_mounted") {
      if (revealAttempts >= revealBudget) {
        // Terminal: keep the current scrollTop, never silently fall back to latest.
        input.emitDiagnostic?.({
          reason,
          outcome: "exhausted",
          anchorKind: position.kind,
          anchorMessageID: anchorMessageID(position),
          revealAttempts,
        })
        dirty = false
        snapshot = undefined
        revealAttempts = 0
        setActive(false)
        return "exhausted"
      }
      revealAttempts += 1
      input.requestReveal?.(position)
      setActive(true)
      pendingReason = "reveal-retry"
      scheduleFlush()
      return "pending-reveal"
    }

    // invalid_anchor or viewport_missing: nothing to reconcile.
    return settle("noop", reason, position)
  }

  return {
    markDirty: (reason) => {
      pendingReason = reason
      dirty = true
      setActive(true)
      scheduleFlush()
    },
    withAnchorSnapshot: (reason, mutate) => {
      snapshot = (input.sampleAnchor ?? input.resolveAnchor)()
      pendingReason = reason
      dirty = true
      setActive(true)
      try {
        mutate()
      } finally {
        scheduleFlush()
      }
    },
    flush,
    active: () => active,
    cancel: () => {
      generation += 1
      if (frameHandle !== undefined) {
        cancelFrame(frameHandle)
        frameHandle = undefined
      }
      dirty = false
      snapshot = undefined
      revealAttempts = 0
      setActive(false)
    },
  }
}
