import { describe, expect, test } from "bun:test"
import { chooseTimelineRowRenderMode, TIMELINE_PLAIN_RENDER_ROW_LIMIT } from "./timeline-virtualization-strategy"

describe("timeline virtualization strategy", () => {
  test("renders short timelines without the virtualizer overhead", () => {
    expect(chooseTimelineRowRenderMode({ rowCount: 0 })).toBe("plain")
    expect(chooseTimelineRowRenderMode({ rowCount: TIMELINE_PLAIN_RENDER_ROW_LIMIT })).toBe("plain")
    expect(chooseTimelineRowRenderMode({ rowCount: TIMELINE_PLAIN_RENDER_ROW_LIMIT + 1 })).toBe("virtualized")
  })
})
