import { describe, expect, test } from "bun:test"
import {
  clampTurnChangeDiffReservedHeight,
  estimateTurnChangeDiffReservedHeight,
} from "./session-turn-change-diff-height"

const diff = (deletions: number, additions: number) => ({
  deletionLines: Array.from({ length: deletions }, (_, index) => `old ${index}`),
  additionLines: Array.from({ length: additions }, (_, index) => `new ${index}`),
})

describe("turn-change diff height reservation", () => {
  test("estimates height from the larger side of the diff plus a small render buffer", () => {
    expect(estimateTurnChangeDiffReservedHeight(diff(3, 8))).toBe(240)
  })

  test("caps reserved height at the existing inline diff max height", () => {
    expect(estimateTurnChangeDiffReservedHeight(diff(50, 50))).toBe(420)
  })

  test("keeps a usable minimum for tiny diffs", () => {
    expect(clampTurnChangeDiffReservedHeight(0)).toBe(48)
    expect(estimateTurnChangeDiffReservedHeight(diff(0, 0))).toBe(72)
  })
})
