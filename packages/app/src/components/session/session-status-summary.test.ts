import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"

// Slice 3 of Area B (#602) replaces the right-panel Status todo dots with the
// canonical todo widget marker per DESIGN.md L201. The marker itself now lives
// in packages/ui/components/todo-status-marker.tsx and has its own contract
// test; this file only guards the right-panel-specific row behaviour:
// no leftover coloured-dot classes, correct strikethrough rules, and the
// import wiring that delegates marker rendering to the shared component.
// Source-text matches the pattern used by session-side-panel.test.tsx.
const SOURCE = fs.readFileSync(new URL("session-status-summary.tsx", import.meta.url), "utf8")

describe("session-status-summary · row contract", () => {
  test("does not render todo state as a coloured dot", () => {
    // Old implementation used `bg-icon-success-base` / `bg-icon-info-base` /
    // `bg-border-weak` on a `size-2 rounded-full` div. None of those should remain.
    expect(SOURCE).not.toMatch(/size-2\s+rounded-full/)
    expect(SOURCE).not.toMatch(/bg-icon-success-base/)
    expect(SOURCE).not.toMatch(/bg-icon-info-base/)
    expect(SOURCE).not.toContain("TODO_STATUS_STYLES")
  })

  test("delegates marker rendering to the shared TodoStatusMarker component", () => {
    // The 13×13 ring + circle/circle-check switch is owned by
    // packages/ui/components/todo-status-marker.tsx and tested there.
    expect(SOURCE).toMatch(
      /import\s*\{\s*TodoStatusMarker\s*\}\s*from\s*"@opencode-ai\/ui\/todo-status-marker"/,
    )
    expect(SOURCE).toMatch(/<TodoStatusMarker\s+status=\{props\.todo\.status\}\s+marginTop="1px"\s*\/>/)
    // The inlined marker JSX must no longer live here.
    expect(SOURCE).not.toContain("--animate-pw-spin")
    expect(SOURCE).not.toContain("circle-check")
  })

  test("strikes through completed and cancelled rows uniformly", () => {
    // Original code only struck cancelled; the dock strikes both. Verify isDone covers both.
    expect(SOURCE).toMatch(/status === "completed"\s*\|\|\s*props\.todo\.status === "cancelled"/)
    expect(SOURCE).toContain("line-through text-fg-weak")
  })

  test("does not render the empty progress fallback while todo hydrate is pending", () => {
    expect(SOURCE).toContain("selectSessionTodoDataSnapshot")
    expect(SOURCE).toContain('snapshot().phase !== "pending"')
  })
})
