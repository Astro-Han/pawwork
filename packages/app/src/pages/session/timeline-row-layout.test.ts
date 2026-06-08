import { describe, expect, test } from "bun:test"
import { timelineMessageRowStyle } from "./timeline-row-layout"

describe("timeline row layout", () => {
  test("keeps inactive plain rows fully laid out", () => {
    expect(timelineMessageRowStyle({ mode: "plain", active: false })).toBeUndefined()
  })

  test("keeps active plain rows fully laid out", () => {
    expect(timelineMessageRowStyle({ mode: "plain", active: true })).toBeUndefined()
  })

  test("leaves virtualized rows to the virtualizer measurement path", () => {
    expect(timelineMessageRowStyle({ mode: "virtualized", active: false })).toBeUndefined()
  })
})
