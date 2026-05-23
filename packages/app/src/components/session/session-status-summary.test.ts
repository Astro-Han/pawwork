import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"

// Slice 3 of Area B (#602) replaces the right-panel Status todo dots with the
// canonical todo widget marker (Icon + 13×13 pw-spin ring) per DESIGN.md L201.
// We assert against source text so the contract survives without pulling in a
// Solid renderer; the same pattern is used by session-side-panel.test.tsx.
const SOURCE = fs.readFileSync(new URL("session-status-summary.tsx", import.meta.url), "utf8")

describe("session-status-summary · todo marker contract", () => {
  test("does not render todo state as a coloured dot", () => {
    // Old implementation used `bg-icon-success-base` / `bg-icon-info-base` /
    // `bg-border-weak` on a `size-2 rounded-full` div. None of those should remain.
    expect(SOURCE).not.toMatch(/size-2\s+rounded-full/)
    expect(SOURCE).not.toMatch(/bg-icon-success-base/)
    expect(SOURCE).not.toMatch(/bg-icon-info-base/)
    expect(SOURCE).not.toContain("TODO_STATUS_STYLES")
  })

  test("maps completed status to the circle-check icon", () => {
    expect(SOURCE).toMatch(/status === "completed"\s*\?\s*"circle-check"\s*:\s*"circle"/)
  })

  test("renders the in-progress spinner via --animate-pw-spin", () => {
    // The running marker mirrors session-todo-dock / todowrite: a 13×13 ring with
    // brand-primary as the top border colour, animated by the shared pw-spin token.
    expect(SOURCE).toContain("--animate-pw-spin")
    expect(SOURCE).toContain("border-top-color")
    expect(SOURCE).toContain("var(--brand-primary)")
  })

  test("strikes through completed and cancelled rows uniformly", () => {
    // Old code only struck cancelled; the dock strikes both. Verify isDone covers both.
    expect(SOURCE).toMatch(/status === "completed"\s*\|\|\s*props\.todo\.status === "cancelled"/)
    expect(SOURCE).toContain("line-through text-fg-weak")
  })

  test("imports Icon from the shared ui package", () => {
    expect(SOURCE).toMatch(/import\s*\{\s*Icon\s*\}\s*from\s*"@opencode-ai\/ui\/icon"/)
  })
})
