import type { TimelineSafePosition } from "./session-timeline-scroll-controller"
import type { TimelineReconcileOutcome, TimelineReconcileReason } from "./timeline-scroll-reconciler"

export type TimelineLayoutStabilizer = {
  stabilize: (input: { reason: TimelineReconcileReason; mutate: () => void }) => TimelineReconcileOutcome
  restore: (reason: TimelineReconcileReason) => TimelineReconcileOutcome
}

export function createTimelineLayoutStabilizer(input: {
  sampleAnchor: () => TimelineSafePosition
  restoreNow: (reason: TimelineReconcileReason, position: TimelineSafePosition) => TimelineReconcileOutcome
}): TimelineLayoutStabilizer {
  const restoreSampledAnchor = (reason: TimelineReconcileReason) => input.restoreNow(reason, input.sampleAnchor())

  return {
    stabilize: ({ reason, mutate }) => {
      const position = input.sampleAnchor()
      mutate()
      return input.restoreNow(reason, position)
    },
    restore: restoreSampledAnchor,
  }
}
