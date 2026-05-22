import { describe, expect, test } from "bun:test"
import { shouldApplyTimelineRecoveryForObservation } from "./timeline-layout-recovery-policy"

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
