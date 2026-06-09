import type {
  TimelineSafePosition,
  TimelineScrollControllerResult,
  TimelineScrollObservation,
} from "./session-timeline-scroll-controller"
import type { TimelineReconcileOutcome, TimelineReconcileReason } from "./timeline-scroll-reconciler"

export function handleTimelineScrollObservation(input: {
  observation: TimelineScrollObservation
  viewport: HTMLElement | undefined
  sampleAnchor: () => TimelineSafePosition
  observe: (observation: TimelineScrollObservation) => TimelineScrollControllerResult
  restoreNow: (reason: TimelineReconcileReason, position?: TimelineSafePosition) => TimelineReconcileOutcome
}): TimelineScrollControllerResult {
  const observation = withSafePosition(input)
  const result = input.observe(observation)

  if (
    observation.type === "scroll_sample" &&
    !observation.userInitiated &&
    !observation.metrics.nearBottom &&
    result.mode === "following_latest"
  ) {
    input.restoreNow("scroll-drift", observation.safePosition)
  }

  return result
}

function withSafePosition(input: {
  observation: TimelineScrollObservation
  viewport: HTMLElement | undefined
  sampleAnchor: () => TimelineSafePosition
}): TimelineScrollObservation {
  if (input.observation.type !== "scroll_sample") return input.observation
  if (input.observation.safePosition) return input.observation
  if (!input.viewport) return input.observation
  return { ...input.observation, safePosition: input.sampleAnchor() }
}
