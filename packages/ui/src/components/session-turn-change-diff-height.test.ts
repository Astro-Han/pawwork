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

const replacementPatch = [
  "diff --git a/file.ts b/file.ts",
  "index 1111111..2222222 100644",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,7 +1,7 @@",
  " context one",
  " context two",
  " context three",
  "-old value",
  "+new value",
  " context four",
  " context five",
  " context six",
].join("\n")

describe("turn-change diff height reservation", () => {
  test("estimates additions-only height plus a small render buffer", () => {
    expect(estimateTurnChangeDiffReservedHeight(diff(0, 8))).toBe(240)
  })

  test("reserves both sides of a unified replacement hunk", () => {
    expect(estimateTurnChangeDiffReservedHeight(diff(6, 8))).toBe(384)
  })

  test("counts unified patch context once when the patch is available", () => {
    expect(estimateTurnChangeDiffReservedHeight({ ...diff(7, 7), patch: replacementPatch })).toBe(240)
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
    expect(panelSource).toContain("createEffect(() =>")
    expect(panelSource).toContain("setMeasuredDiffHeight(undefined)")
    expect(panelSource).toContain("const reservedDiffHeight = () =>")
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
