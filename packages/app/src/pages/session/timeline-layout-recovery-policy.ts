import type { TimelineScrollObservation } from "./session-timeline-scroll-controller"

export function shouldApplyTimelineRecoveryForObservation(input: {
  layoutTransactionActive: boolean
  observationType: TimelineScrollObservation["type"]
}) {
  if (!input.layoutTransactionActive) return true
  return input.observationType !== "content_resize" && input.observationType !== "dock_resize"
}
