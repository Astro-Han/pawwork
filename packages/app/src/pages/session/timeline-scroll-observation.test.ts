import { describe, expect, test } from "bun:test"
import type {
  TimelineSafePosition,
  TimelineScrollControllerResult,
  TimelineScrollMetrics,
  TimelineScrollObservation,
} from "./session-timeline-scroll-controller"
import { handleTimelineScrollObservation } from "./timeline-scroll-observation"
import type { TimelineReconcileReason } from "./timeline-scroll-reconciler"

const offBottomMetrics: TimelineScrollMetrics = {
  scrollTop: 1249.5,
  scrollHeight: 2591,
  clientHeight: 905,
  distanceFromTop: 1249.5,
  distanceFromBottom: 436.5,
  nearTop: false,
  nearBottom: false,
}

function followingLatestResult(reason: TimelineScrollControllerResult["reason"]): TimelineScrollControllerResult {
  return {
    accepted: true,
    mode: "following_latest",
    anchorChanged: false,
    reason,
  }
}

function readingHistoryResult(reason: TimelineScrollControllerResult["reason"]): TimelineScrollControllerResult {
  return {
    accepted: true,
    mode: "reading_history",
    anchorChanged: false,
    reason,
  }
}

describe("timeline scroll observation", () => {
  test("repins non-user drift immediately while following latest", () => {
    const latest: TimelineSafePosition = { kind: "latest", messageID: "msg_latest" }
    const observed: TimelineScrollObservation[] = []
    const restored: Array<{ reason: TimelineReconcileReason; position?: TimelineSafePosition }> = []

    const result = handleTimelineScrollObservation({
      observation: {
        type: "scroll_sample",
        metrics: offBottomMetrics,
        userInitiated: false,
      },
      viewport: {} as HTMLElement,
      sampleAnchor: () => latest,
      observe: (observation) => {
        observed.push(observation)
        return followingLatestResult("weak_scroll_observed")
      },
      restoreNow: (reason, position) => {
        restored.push({ reason, position })
        return "pinned"
      },
    })

    expect(result).toEqual(followingLatestResult("weak_scroll_observed"))
    expect(observed).toEqual([
      {
        type: "scroll_sample",
        metrics: offBottomMetrics,
        safePosition: latest,
        userInitiated: false,
      },
    ])
    expect(restored).toEqual([{ reason: "scroll-drift", position: latest }])
  })

  test("does not repin a user-initiated scroll", () => {
    const latest: TimelineSafePosition = { kind: "latest", messageID: "msg_latest" }
    const restored: Array<{ reason: TimelineReconcileReason; position?: TimelineSafePosition }> = []

    handleTimelineScrollObservation({
      observation: {
        type: "scroll_sample",
        metrics: offBottomMetrics,
        userInitiated: true,
      },
      viewport: {} as HTMLElement,
      sampleAnchor: () => latest,
      observe: () => followingLatestResult("weak_scroll_observed"),
      restoreNow: (reason, position) => {
        restored.push({ reason, position })
        return "pinned"
      },
    })

    expect(restored).toEqual([])
  })

  test("does not repin while the controller is reading history", () => {
    const reading: TimelineSafePosition = {
      kind: "reading",
      anchorMessageID: "msg_anchor",
      offsetFromViewportTop: 24,
      renderedStart: 0,
      renderedCount: 8,
    }
    const restored: Array<{ reason: TimelineReconcileReason; position?: TimelineSafePosition }> = []

    handleTimelineScrollObservation({
      observation: {
        type: "scroll_sample",
        metrics: offBottomMetrics,
        userInitiated: false,
      },
      viewport: {} as HTMLElement,
      sampleAnchor: () => reading,
      observe: () => readingHistoryResult("reading_anchor_sampled"),
      restoreNow: (reason, position) => {
        restored.push({ reason, position })
        return "pinned"
      },
    })

    expect(restored).toEqual([])
  })
})
