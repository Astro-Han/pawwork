import { describe, expect, test } from "bun:test"
import { timelineDriverEnabled, type TimelineWindow } from "./timeline"

describe("timeline e2e driver", () => {
  test("stays disabled outside explicit test runtime even when the window flag is set", () => {
    const win = { __opencode_e2e: { timeline: { enabled: true } } } as TimelineWindow

    expect(timelineDriverEnabled({ testRuntime: false, windowRef: win })).toBe(false)
  })

  test("requires the window flag inside explicit test runtime", () => {
    const win = { __opencode_e2e: { timeline: { enabled: true } } } as TimelineWindow

    expect(timelineDriverEnabled({ testRuntime: true, windowRef: win })).toBe(true)
    expect(timelineDriverEnabled({ testRuntime: true, windowRef: {} as TimelineWindow })).toBe(false)
  })
})
