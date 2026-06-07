import { describe, expect, test } from "bun:test"
import { rectsEqual, shouldShowBrowserView } from "./view-state"

describe("shouldShowBrowserView", () => {
  const base = { panelOpen: true, active: true, hasPage: true, suppressed: false }

  test("shows only when open, active, has a page, and not suppressed", () => {
    expect(shouldShowBrowserView(base)).toBe(true)
  })

  test("hides when any precondition fails", () => {
    expect(shouldShowBrowserView({ ...base, panelOpen: false })).toBe(false)
    expect(shouldShowBrowserView({ ...base, active: false })).toBe(false)
    expect(shouldShowBrowserView({ ...base, hasPage: false })).toBe(false)
    expect(shouldShowBrowserView({ ...base, suppressed: true })).toBe(false)
  })
})

describe("rectsEqual", () => {
  test("treats null pairs as equal and null/value as unequal", () => {
    expect(rectsEqual(null, null)).toBe(true)
    expect(rectsEqual(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
    expect(rectsEqual({ x: 0, y: 0, width: 1, height: 1 }, null)).toBe(false)
  })

  test("ignores sub-pixel jitter but catches device-pixel changes", () => {
    expect(rectsEqual({ x: 10.1, y: 20.2, width: 30.4, height: 40 }, { x: 10, y: 20, width: 30, height: 40 })).toBe(
      true,
    )
    expect(rectsEqual({ x: 10, y: 20, width: 30, height: 40 }, { x: 11, y: 20, width: 30, height: 40 })).toBe(false)
  })
})
