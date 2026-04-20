import { describe, expect, test } from "bun:test"
import { DEFAULT_TOAST_DURATION_MS, normalizeToastDuration } from "../../../src/cli/cmd/tui/ui/toast"

describe("toast duration", () => {
  test("falls back to the default duration when omitted", () => {
    expect(normalizeToastDuration(undefined)).toBe(DEFAULT_TOAST_DURATION_MS)
  })

  test("falls back to the default duration when non-positive", () => {
    expect(normalizeToastDuration(0)).toBe(DEFAULT_TOAST_DURATION_MS)
    expect(normalizeToastDuration(-1)).toBe(DEFAULT_TOAST_DURATION_MS)
  })

  test("keeps explicit positive durations", () => {
    expect(normalizeToastDuration(1500)).toBe(1500)
  })
})
