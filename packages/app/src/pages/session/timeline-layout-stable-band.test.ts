import { describe, expect, test } from "bun:test"
import {
  chooseTimelineVirtualizerOverscan,
  TIMELINE_ACTIVE_OVERSCAN,
  TIMELINE_BASE_OVERSCAN,
} from "./timeline-layout-stable-band"

describe("timeline layout stable band", () => {
  test("keeps normal overscan small while the reconciler is idle", () => {
    expect(chooseTimelineVirtualizerOverscan({ reconcilerActive: false })).toBe(TIMELINE_BASE_OVERSCAN)
  })

  test("widens overscan only while the reconciler is active", () => {
    expect(chooseTimelineVirtualizerOverscan({ reconcilerActive: true })).toBe(TIMELINE_ACTIVE_OVERSCAN)
    expect(TIMELINE_ACTIVE_OVERSCAN).toBeGreaterThan(TIMELINE_BASE_OVERSCAN)
  })
})
