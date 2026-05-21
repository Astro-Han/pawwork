import type { TimelineSafePosition, TimelineScrollMode } from "./session-timeline-scroll-controller"

export type TimelineLayoutTransactionKind = "dock-resize" | "content-resize" | "row-measurement" | "end-of-turn-settle"
export type TimelineLayoutTransactionPhase = "start" | "fallback" | "settled" | "violation"
export type TimelineLayoutTransactionStatus = "before-paint" | "fallback" | "violation" | "no-op"
export type TimelineLayoutTransactionViolation = "anchor_restore_exceeded_fallback_budget"

export type TimelineLayoutTransactionFrameScheduler = (callback: () => void) => number

export type TimelineLayoutTransactionDiagnostic = {
  transactionID: string
  kind: TimelineLayoutTransactionKind
  phase: TimelineLayoutTransactionPhase
  monotonicMs: number
  mode: TimelineScrollMode
  source: string
  reason: string
  anchorKind: TimelineSafePosition["kind"]
  anchorMessageID?: string
  fallbackFrames: number
  violation?: TimelineLayoutTransactionViolation
}

export type TimelineLayoutTransactionResult = {
  transactionID: string
  kind: TimelineLayoutTransactionKind
  status: TimelineLayoutTransactionStatus
  anchor: TimelineSafePosition
  fallbackFrames: number
  violation?: TimelineLayoutTransactionViolation
}

export type TimelineLayoutTransactionRunInput = {
  kind: TimelineLayoutTransactionKind
  source: string
  reason: string
  mutate: () => void
  mode?: TimelineScrollMode
  restoreLatest?: (transactionID: string) => boolean
}

export type TimelineLayoutTransactionState =
  | {
      active: true
      transactionID: string
      kind: TimelineLayoutTransactionKind
    }
  | {
      active: false
      transactionID?: undefined
      kind?: undefined
    }

function anchorMessageID(anchor: TimelineSafePosition) {
  if (anchor.kind === "reading") return anchor.anchorMessageID
  if (anchor.kind === "target_message") return anchor.messageID
  return anchor.messageID
}

function latestAnchor(): TimelineSafePosition {
  return { kind: "latest" }
}

export function createTimelineLayoutTransactionCoordinator(input: {
  now?: () => number
  scheduleFrame: TimelineLayoutTransactionFrameScheduler
  cancelFrame: (handle: number) => void
  readMode: () => TimelineScrollMode
  sampleAnchor: () => TimelineSafePosition
  restoreAnchor: (anchor: TimelineSafePosition, transactionID: string) => boolean
  restoreLatest: (transactionID: string) => boolean
  setStableBandActive: (active: boolean) => void
  setTransactionState?: (state: TimelineLayoutTransactionState) => void
  emitDiagnostic?: (event: TimelineLayoutTransactionDiagnostic) => void
}) {
  let sequence = 0
  let activeGeneration = 0
  let pendingFrameHandles = new Set<number>()
  const now = input.now ?? (() => performance.now())

  const emit = (event: Omit<TimelineLayoutTransactionDiagnostic, "monotonicMs">) => {
    input.emitDiagnostic?.({ ...event, monotonicMs: now() })
  }

  const clearPendingFrames = () => {
    for (const handle of pendingFrameHandles) input.cancelFrame(handle)
    pendingFrameHandles = new Set()
  }

  const run = (runInput: TimelineLayoutTransactionRunInput): TimelineLayoutTransactionResult => {
    clearPendingFrames()
    sequence += 1
    activeGeneration += 1
    const generation = activeGeneration
    const transactionID = `timeline-layout-${sequence}`
    const mode = runInput.mode ?? input.readMode()
    const anchor = mode === "following_latest" ? latestAnchor() : input.sampleAnchor()
    const restoreLatestForTransaction = runInput.restoreLatest ?? input.restoreLatest
    const base = {
      transactionID,
      kind: runInput.kind,
      mode,
      source: runInput.source,
      reason: runInput.reason,
      anchorKind: anchor.kind,
      anchorMessageID: anchorMessageID(anchor),
    }
    let settled = false
    let result: TimelineLayoutTransactionResult = {
      transactionID,
      kind: runInput.kind,
      status: "fallback",
      anchor,
      fallbackFrames: 1,
    }

    const restore = () =>
      anchor.kind === "latest" ? restoreLatestForTransaction(transactionID) : input.restoreAnchor(anchor, transactionID)

    const settle = (
      status: TimelineLayoutTransactionStatus,
      fallbackFrames: number,
      violation?: TimelineLayoutTransactionViolation,
    ) => {
      if (generation !== activeGeneration || settled) return false
      settled = true
      input.setStableBandActive(false)
      input.setTransactionState?.({ active: false })
      if (violation) {
        emit({ ...base, phase: "violation", fallbackFrames, violation })
      } else {
        emit({ ...base, phase: "settled", fallbackFrames })
      }
      result = { transactionID, kind: runInput.kind, status, anchor, fallbackFrames, violation }
      return true
    }

    const attemptFallbackRestore = (frame: number) => {
      if (generation !== activeGeneration || settled) return
      if (restore()) {
        settle("fallback", frame)
        return
      }
      if (frame >= 2) {
        settle("violation", frame, "anchor_restore_exceeded_fallback_budget")
        return
      }
      scheduleFallback(frame + 1)
    }

    const scheduleFallback = (frame: number) => {
      if (generation !== activeGeneration || settled) return
      emit({ ...base, phase: "fallback", fallbackFrames: frame })
      let handle: number | undefined
      handle = input.scheduleFrame(() => {
        if (handle !== undefined) pendingFrameHandles.delete(handle)
        attemptFallbackRestore(frame)
      })
      if (!settled && generation === activeGeneration) pendingFrameHandles.add(handle)
    }

    input.setStableBandActive(true)
    input.setTransactionState?.({ active: true, transactionID, kind: runInput.kind })
    emit({ ...base, phase: "start", fallbackFrames: 0 })

    try {
      runInput.mutate()

      if (restore()) {
        settle("before-paint", 0)
        return { transactionID, kind: runInput.kind, status: "before-paint", anchor, fallbackFrames: 0 }
      }

      scheduleFallback(1)
      return result
    } catch (error) {
      if (generation === activeGeneration) clearPendingFrames()
      input.setStableBandActive(false)
      input.setTransactionState?.({ active: false })
      throw error
    }
  }

  return { run }
}
