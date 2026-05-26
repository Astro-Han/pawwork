import { describe, expect, test } from "bun:test"
import {
  createSessionTimelineScrollController,
  shouldPreserveLatestForTimelineLayoutChange,
  type TimelineScrollMetrics,
} from "./session-timeline-scroll-controller"
import { shouldApplyTimelineRecoveryForObservation } from "./timeline-layout-recovery-policy"

const nearLatestMetrics: TimelineScrollMetrics = {
  scrollTop: 488,
  scrollHeight: 1000,
  clientHeight: 400,
  distanceFromTop: 488,
  distanceFromBottom: 112,
  nearTop: false,
  nearBottom: false,
}

function makeControllerStateAfterSubmit() {
  const controller = createSessionTimelineScrollController({
    sessionOwner: "ses_1",
    viewportOwner: "viewport_1",
  })
  controller.intent({ type: "submit", originMode: "following_latest" })
  return controller
}

describe("session timeline interaction layout recovery", () => {
  test("lets layout transactions own resize recovery while controller still observes resize", () => {
    expect(
      shouldApplyTimelineRecoveryForObservation({
        layoutTransactionActive: true,
        observationType: "dock_resize",
      }),
    ).toBe(false)
    expect(
      shouldApplyTimelineRecoveryForObservation({
        layoutTransactionActive: true,
        observationType: "content_resize",
      }),
    ).toBe(false)
  })

  test("skips dock resize recovery after an immediate transaction restore has already settled", () => {
    expect(
      shouldApplyTimelineRecoveryForObservation({
        layoutTransactionActive: false,
        layoutTransactionHandled: true,
        observationType: "dock_resize",
      }),
    ).toBe(false)
  })

  test("keeps non-transaction and non-resize recovery paths active", () => {
    expect(
      shouldApplyTimelineRecoveryForObservation({
        layoutTransactionActive: false,
        observationType: "dock_resize",
      }),
    ).toBe(true)
    expect(
      shouldApplyTimelineRecoveryForObservation({
        layoutTransactionActive: true,
        observationType: "scroll_sample",
      }),
    ).toBe(true)
  })
})

describe("shouldPreserveLatestForTimelineLayoutChange", () => {
  test("does not restore latest after ArrowUp leaves latest near the bottom", () => {
    const controller = makeControllerStateAfterSubmit()

    controller.intent({ type: "keyboard_scroll", key: "ArrowUp", source: "scroll_view" })

    expect(
      shouldPreserveLatestForTimelineLayoutChange({
        state: controller.state(),
        bottomFollowLocked: false,
        metrics: nearLatestMetrics,
      }),
    ).toBe(false)
  })

  test("does not restore latest after strong upward wheel leaves latest near the bottom", () => {
    const controller = makeControllerStateAfterSubmit()

    controller.intent({
      type: "wheel_scroll",
      source: "timeline",
      direction: "up",
      strength: "strong",
      nestedScrollable: false,
    })

    expect(
      shouldPreserveLatestForTimelineLayoutChange({
        state: controller.state(),
        bottomFollowLocked: false,
        metrics: nearLatestMetrics,
      }),
    ).toBe(false)
  })

  test("does not restore latest after scrollbar drag leaves latest near the bottom", () => {
    const controller = makeControllerStateAfterSubmit()

    controller.intent({ type: "scrollbar_drag_start", source: "scroll_view", metrics: nearLatestMetrics })
    controller.intent({ type: "scrollbar_drag_end", source: "scroll_view", metrics: nearLatestMetrics })

    expect(
      shouldPreserveLatestForTimelineLayoutChange({
        state: controller.state(),
        bottomFollowLocked: false,
        metrics: nearLatestMetrics,
      }),
    ).toBe(false)
  })
})
