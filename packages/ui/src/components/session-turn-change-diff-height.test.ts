import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  clampTurnChangeDiffReservedHeight,
  estimateTurnChangeDiffReservedHeight,
} from "./session-turn-change-diff-height"

const panelSource = readFileSync(new URL("./session-turn-changes-panel.tsx", import.meta.url), "utf8")
const cssSource = readFileSync(new URL("./session-turn.css", import.meta.url), "utf8")

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

  test("wires the panel to reserve height and refresh the cached measurement after render", () => {
    expect(panelSource).toContain("estimateTurnChangeDiffReservedHeight")
    expect(panelSource).toContain("--turn-change-diff-reserved-height")
    expect(panelSource).toContain("onRendered={handleDiffRendered}")
  })

  test("keeps the reservation scoped to turn-change diffs", () => {
    expect(cssSource).toMatch(
      /\[data-slot="session-turn-change-diff"\][\s\S]*?min-height:\s*var\(--turn-change-diff-reserved-height/,
    )
    expect(cssSource).toMatch(
      /\[data-slot="session-turn-change-diff"\][\s\S]*?\[data-component="file"\][\s\S]*?content-visibility:\s*visible/,
    )
  })
})
