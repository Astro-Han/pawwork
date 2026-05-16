import { describe, expect, test } from "bun:test"
import {
  createTouchTimelineScrollIntent,
  createWheelTimelineScrollIntent,
  scrollViewIntentToTimelineIntent,
  scrollViewMetricsToTimelineMetrics,
  shouldMarkLegacyScrollIntent,
  shouldMarkTimelineBoundaryGesture,
  timelineBoundaryGesture,
} from "./session-timeline-scroll-intents"

const setMetric = (element: HTMLElement, name: "clientHeight" | "scrollHeight" | "scrollTop", value: number) => {
  Object.defineProperty(element, name, { configurable: true, value })
}

const makeRoot = (height = 500) => {
  const root = document.createElement("div")
  setMetric(root, "clientHeight", height)
  return root as HTMLDivElement
}

describe("scrollViewMetricsToTimelineMetrics", () => {
  test("converts scroll view metrics into timeline metrics", () => {
    expect(
      scrollViewMetricsToTimelineMetrics({
        scrollTop: 40,
        scrollHeight: 240,
        clientHeight: 100,
      }),
    ).toEqual({
      scrollTop: 40,
      scrollHeight: 240,
      clientHeight: 100,
      distanceFromTop: 40,
      distanceFromBottom: 100,
      nearTop: false,
      nearBottom: false,
    })
  })

  test("clamps bottom distance and exposes top/bottom thresholds", () => {
    expect(scrollViewMetricsToTimelineMetrics({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toMatchObject({
      distanceFromBottom: 0,
      nearTop: true,
      nearBottom: true,
    })

    expect(scrollViewMetricsToTimelineMetrics({ scrollTop: 98, scrollHeight: 200, clientHeight: 100 })).toMatchObject({
      distanceFromBottom: 2,
      nearTop: false,
      nearBottom: true,
    })
  })
})

describe("scrollViewIntentToTimelineIntent", () => {
  test("keeps keyboard scroll intent discrete", () => {
    expect(scrollViewIntentToTimelineIntent({ type: "keyboard_scroll", key: "Home" })).toEqual({
      type: "keyboard_scroll",
      key: "Home",
      source: "scroll_view",
    })
  })

  test("attaches timeline metrics to scrollbar intents", () => {
    expect(
      scrollViewIntentToTimelineIntent({
        type: "scrollbar_drag_start",
        metrics: { scrollTop: 10, scrollHeight: 210, clientHeight: 100 },
      }),
    ).toEqual({
      type: "scrollbar_drag_start",
      source: "scroll_view",
      metrics: {
        scrollTop: 10,
        scrollHeight: 210,
        clientHeight: 100,
        distanceFromTop: 10,
        distanceFromBottom: 100,
        nearTop: true,
        nearBottom: false,
      },
    })
  })

  test("marks legacy scroll intents that still need gesture cancellation", () => {
    expect(shouldMarkLegacyScrollIntent({ type: "keyboard_scroll", key: "ArrowUp" })).toBe(true)
    expect(
      shouldMarkLegacyScrollIntent({
        type: "scrollbar_drag_start",
        metrics: { scrollTop: 0, scrollHeight: 100, clientHeight: 100 },
      }),
    ).toBe(true)
    expect(
      shouldMarkLegacyScrollIntent({
        type: "scrollbar_drag_end",
        metrics: { scrollTop: 0, scrollHeight: 100, clientHeight: 100 },
      }),
    ).toBe(false)
  })
})

describe("timelineBoundaryGesture", () => {
  test("treats main timeline gestures as boundary gestures", () => {
    const root = makeRoot()

    const boundary = timelineBoundaryGesture({ root, target: root, delta: 20 })

    expect(boundary).toEqual({ nestedScrollable: false, atNestedBoundary: true })
    expect(shouldMarkTimelineBoundaryGesture(boundary)).toBe(true)
  })

  test("does not mark nested scrollables that can consume the gesture", () => {
    const root = makeRoot()
    const nested = document.createElement("div")
    nested.setAttribute("data-scrollable", "")
    setMetric(nested, "scrollTop", 100)
    setMetric(nested, "scrollHeight", 300)
    setMetric(nested, "clientHeight", 100)
    root.append(nested)

    const boundary = timelineBoundaryGesture({ root, target: nested, delta: 20 })

    expect(boundary).toEqual({ nestedScrollable: true, atNestedBoundary: false })
    expect(shouldMarkTimelineBoundaryGesture(boundary)).toBe(false)
  })

  test("marks nested scrollables once they hit their boundary", () => {
    const root = makeRoot()
    const nested = document.createElement("div")
    nested.setAttribute("data-scrollable", "")
    setMetric(nested, "scrollTop", 0)
    setMetric(nested, "scrollHeight", 300)
    setMetric(nested, "clientHeight", 100)
    root.append(nested)

    const boundary = timelineBoundaryGesture({ root, target: nested, delta: -20 })

    expect(boundary).toEqual({ nestedScrollable: true, atNestedBoundary: true })
    expect(shouldMarkTimelineBoundaryGesture(boundary)).toBe(true)
  })
})

describe("timeline pointer intents", () => {
  test("normalizes wheel gestures into timeline intents", () => {
    const root = makeRoot(500)

    expect(createWheelTimelineScrollIntent({ root, target: root, deltaY: -1, deltaMode: 2 })).toEqual({
      delta: -500,
      boundary: { nestedScrollable: false, atNestedBoundary: true },
      intent: {
        type: "wheel_scroll",
        source: "timeline",
        direction: "up",
        strength: "strong",
        nestedScrollable: false,
      },
    })
  })

  test("returns undefined for zero wheel and touch deltas", () => {
    const root = makeRoot()

    expect(createWheelTimelineScrollIntent({ root, target: root, deltaY: 0, deltaMode: 0 })).toBeUndefined()
    expect(createTouchTimelineScrollIntent({ root, target: root, delta: 0 })).toBeUndefined()
  })

  test("normalizes touch deltas into timeline intents", () => {
    const root = makeRoot()

    expect(createTouchTimelineScrollIntent({ root, target: root, delta: 24 })).toMatchObject({
      delta: 24,
      boundary: { nestedScrollable: false, atNestedBoundary: true },
      intent: {
        type: "touch_scroll",
        source: "timeline",
        direction: "down",
        nestedScrollable: false,
      },
    })
  })
})
