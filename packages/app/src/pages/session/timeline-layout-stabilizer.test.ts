import { describe, expect, test } from "bun:test"
import type { TimelineSafePosition } from "./session-timeline-scroll-controller"
import { createTimelineLayoutStabilizer } from "./timeline-layout-stabilizer"
import type { TimelineReconcileOutcome, TimelineReconcileReason } from "./timeline-scroll-reconciler"

describe("timeline layout stabilizer", () => {
  test("samples the anchor before mutation and restores it before returning", () => {
    const order: string[] = []
    const sampled: TimelineSafePosition = {
      kind: "reading",
      anchorMessageID: "msg_anchor",
      offsetFromViewportTop: 24,
      renderedStart: 0,
      renderedCount: 10,
    }
    const restored: Array<{ reason: TimelineReconcileReason; position: TimelineSafePosition }> = []
    const stabilizer = createTimelineLayoutStabilizer({
      sampleAnchor: () => {
        order.push("sample")
        return sampled
      },
      restoreNow: (reason, position) => {
        order.push("restore")
        restored.push({ reason, position })
        return "pinned"
      },
    })

    const outcome = stabilizer.stabilize({
      reason: "content-resize",
      mutate: () => {
        order.push("mutate")
      },
    })

    expect(outcome).toBe("pinned")
    expect(order).toEqual(["sample", "mutate", "restore"])
    expect(restored).toEqual([{ reason: "content-resize", position: sampled }])
  })

  test("can restore an already-applied layout change through the same path", () => {
    const latest: TimelineSafePosition = { kind: "latest", messageID: "msg_latest" }
    const restored: Array<{ reason: TimelineReconcileReason; position: TimelineSafePosition }> = []
    const stabilizer = createTimelineLayoutStabilizer({
      sampleAnchor: () => latest,
      restoreNow: (reason, position) => {
        restored.push({ reason, position })
        return "noop"
      },
    })

    expect(stabilizer.restore("frame-changed")).toBe("noop")
    expect(restored).toEqual([{ reason: "frame-changed", position: latest }])
  })

  test("surfaces reveal fallback outcomes from the reconciler", () => {
    const latest: TimelineSafePosition = { kind: "latest", messageID: "msg_latest" }
    const stabilizer = createTimelineLayoutStabilizer({
      sampleAnchor: () => latest,
      restoreNow: () => "pending-reveal" as TimelineReconcileOutcome,
    })

    expect(stabilizer.stabilize({ reason: "dock-resize", mutate: () => {} })).toBe("pending-reveal")
  })
})
