import { describe, expect, test } from "bun:test"
import { timelineMessageRowStyle } from "./timeline-row-layout"

describe("timeline row layout", () => {
  test("keeps browser lazy layout on inactive plain rows", () => {
    expect(timelineMessageRowStyle({ mode: "plain", active: false })).toEqual({
      "content-visibility": "auto",
      "contain-intrinsic-size": "auto 500px",
    })
  })

  test("does not lazy-layout active plain rows", () => {
    expect(timelineMessageRowStyle({ mode: "plain", active: true })).toBeUndefined()
  })

  test("leaves virtualized rows to the virtualizer measurement path", () => {
    expect(timelineMessageRowStyle({ mode: "virtualized", active: false })).toBeUndefined()
  })
})
