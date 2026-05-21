import type { TimelineScrollObservation } from "./session-timeline-scroll-controller"

export function shouldApplyTimelineRecoveryForObservation(input: {
  layoutTransactionActive: boolean
  layoutTransactionHandled?: boolean
  observationType: TimelineScrollObservation["type"]
}) {
  const resizeObservation = input.observationType === "content_resize" || input.observationType === "dock_resize"
  if (input.layoutTransactionHandled && resizeObservation) return false
  if (!input.layoutTransactionActive) return true
  return !resizeObservation
}
