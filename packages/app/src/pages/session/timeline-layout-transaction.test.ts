import { describe, expect, test } from "bun:test"
import {
  createTimelineLayoutTransactionCoordinator,
  type TimelineLayoutTransactionDiagnostic,
  type TimelineLayoutTransactionFrameScheduler,
} from "./timeline-layout-transaction"
import type { TimelineSafePosition, TimelineScrollMode } from "./session-timeline-scroll-controller"

const readingAnchor: TimelineSafePosition = {
  kind: "reading",
  anchorMessageID: "msg-2",
  offsetFromViewportTop: 96,
  renderedStart: 0,
  renderedCount: 12,
}

function immediateFrameScheduler(): TimelineLayoutTransactionFrameScheduler {
  return (callback) => {
    callback()
    return 1
  }
}

function makeCoordinator(input?: {
  mode?: TimelineScrollMode
  restoreResults?: boolean[]
  diagnostics?: TimelineLayoutTransactionDiagnostic[]
}) {
  let restoreCalls = 0
  let latestCalls = 0
  let stableBand = false
  const restoreResults = input?.restoreResults ?? [true]
  const diagnostics = input?.diagnostics ?? []
  const coordinator = createTimelineLayoutTransactionCoordinator({
    now: () => 123 + diagnostics.length,
    scheduleFrame: immediateFrameScheduler(),
    cancelFrame: () => {},
    readMode: () => input?.mode ?? "reading_history",
    sampleAnchor: () => readingAnchor,
    restoreAnchor: () => restoreResults[Math.min(restoreCalls++, restoreResults.length - 1)] ?? false,
    restoreLatest: () => {
      latestCalls += 1
      return true
    },
    setStableBandActive: (active) => {
      stableBand = active
    },
    emitDiagnostic: (event) => diagnostics.push(event),
  })
  return {
    coordinator,
    diagnostics,
    restoreCalls: () => restoreCalls,
    latestCalls: () => latestCalls,
    stableBand: () => stableBand,
  }
}

describe("timeline layout transaction coordinator", () => {
  test("restores the sampled reading anchor before paint", () => {
    const { coordinator, diagnostics, restoreCalls, stableBand } = makeCoordinator()
    const mutations: string[] = []

    const result = coordinator.run({
      kind: "dock-resize",
      source: "use-session-scroll-dock/updateDockHeight",
      reason: "question-dock-close",
      mutate: () => mutations.push("dock-height-applied"),
    })

    expect(mutations).toEqual(["dock-height-applied"])
    expect(restoreCalls()).toBe(1)
    expect(stableBand()).toBe(false)
    expect(result.status).toBe("before-paint")
    expect(result.anchor).toEqual(readingAnchor)
    expect(diagnostics.map((event) => event.phase)).toEqual(["start", "settled"])
  })

  test("preserves latest instead of reading anchor when already following latest", () => {
    const { coordinator, latestCalls, restoreCalls } = makeCoordinator({ mode: "following_latest" })

    const result = coordinator.run({
      kind: "dock-resize",
      source: "use-session-scroll-dock/updateDockHeight",
      reason: "composer-growth",
      mutate: () => {},
    })

    expect(result.status).toBe("before-paint")
    expect(result.anchor).toEqual({ kind: "latest" })
    expect(latestCalls()).toBe(1)
    expect(restoreCalls()).toBe(0)
  })

  test("uses a bounded two-frame fallback when the anchor is not immediately restorable", () => {
    const { coordinator, diagnostics, restoreCalls } = makeCoordinator({ restoreResults: [false, true] })

    const result = coordinator.run({
      kind: "content-resize",
      source: "use-session-scroll-dock/contentObserver",
      reason: "streaming-content-resize",
      mutate: () => {},
    })

    expect(result.status).toBe("fallback")
    expect(result.fallbackFrames).toBe(1)
    expect(restoreCalls()).toBe(2)
    expect(diagnostics.map((event) => event.phase)).toEqual(["start", "fallback", "settled"])
  })

  test("reports a violation after the two-frame fallback budget is exceeded", () => {
    const { coordinator, diagnostics, restoreCalls } = makeCoordinator({ restoreResults: [false, false, false] })

    const result = coordinator.run({
      kind: "row-measurement",
      source: "timeline-virtualizer-bridge/measurement",
      reason: "virtual-row-height-change",
      mutate: () => {},
    })

    expect(result.status).toBe("violation")
    expect(result.violation).toBe("anchor_restore_exceeded_fallback_budget")
    expect(result.fallbackFrames).toBe(2)
    expect(restoreCalls()).toBe(3)
    expect(diagnostics.at(-1)).toMatchObject({
      phase: "violation",
      violation: "anchor_restore_exceeded_fallback_budget",
    })
  })
})
