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
  emitDiagnostic?: (event: TimelineLayoutTransactionDiagnostic) => void
}) {
  let sequence = 0
  const now = input.now ?? (() => performance.now())

  const emit = (event: Omit<TimelineLayoutTransactionDiagnostic, "monotonicMs">) => {
    input.emitDiagnostic?.({ ...event, monotonicMs: now() })
  }

  const run = (runInput: TimelineLayoutTransactionRunInput): TimelineLayoutTransactionResult => {
    sequence += 1
    const transactionID = `timeline-layout-${sequence}`
    const mode = input.readMode()
    const anchor = mode === "following_latest" ? latestAnchor() : input.sampleAnchor()
    const base = {
      transactionID,
      kind: runInput.kind,
      mode,
      source: runInput.source,
      reason: runInput.reason,
      anchorKind: anchor.kind,
      anchorMessageID: anchorMessageID(anchor),
    }

    input.setStableBandActive(true)
    emit({ ...base, phase: "start", fallbackFrames: 0 })

    try {
      runInput.mutate()

      const restored =
        anchor.kind === "latest" ? input.restoreLatest(transactionID) : input.restoreAnchor(anchor, transactionID)
      if (restored) {
        input.setStableBandActive(false)
        emit({ ...base, phase: "settled", fallbackFrames: 0 })
        return { transactionID, kind: runInput.kind, status: "before-paint", anchor, fallbackFrames: 0 }
      }

      for (let frame = 1; frame <= 2; frame += 1) {
        emit({ ...base, phase: "fallback", fallbackFrames: frame })
        let fallbackRestored = false
        input.scheduleFrame(() => {
          fallbackRestored =
            anchor.kind === "latest" ? input.restoreLatest(transactionID) : input.restoreAnchor(anchor, transactionID)
        })
        if (fallbackRestored) {
          input.setStableBandActive(false)
          emit({ ...base, phase: "settled", fallbackFrames: frame })
          return { transactionID, kind: runInput.kind, status: "fallback", anchor, fallbackFrames: frame }
        }
      }

      input.setStableBandActive(false)
      emit({
        ...base,
        phase: "violation",
        fallbackFrames: 2,
        violation: "anchor_restore_exceeded_fallback_budget",
      })
      return {
        transactionID,
        kind: runInput.kind,
        status: "violation",
        anchor,
        fallbackFrames: 2,
        violation: "anchor_restore_exceeded_fallback_budget",
      }
    } catch (error) {
      input.setStableBandActive(false)
      throw error
    }
  }

  return { run }
}
