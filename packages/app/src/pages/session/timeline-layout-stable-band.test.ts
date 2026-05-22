import { describe, expect, test } from "bun:test"
import {
  chooseTimelineVirtualizerOverscan,
  TIMELINE_BASE_OVERSCAN,
  TIMELINE_TRANSACTION_OVERSCAN,
} from "./timeline-layout-stable-band"

describe("timeline layout stable band", () => {
  test("keeps normal overscan small outside transactions", () => {
    expect(chooseTimelineVirtualizerOverscan({ transactionActive: false })).toBe(TIMELINE_BASE_OVERSCAN)
  })

  test("widens overscan only during a layout transaction", () => {
    expect(chooseTimelineVirtualizerOverscan({ transactionActive: true })).toBe(TIMELINE_TRANSACTION_OVERSCAN)
    expect(TIMELINE_TRANSACTION_OVERSCAN).toBeGreaterThan(TIMELINE_BASE_OVERSCAN)
  })
})
