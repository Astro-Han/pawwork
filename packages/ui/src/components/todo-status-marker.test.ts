import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// TodoStatusMarker is the single source of truth for the todo state marker
// rendered by the composer dock, the message-part TodoWrite tool card, and
// the right-panel Status tab. DESIGN.md L201 forbids dots; the marker shape
// is the SVG-icon-and-spinner contract that replaces them.
const SOURCE = readFileSync(new URL("./todo-status-marker.tsx", import.meta.url), "utf8")

describe("todo-status-marker · visual contract", () => {
  test("declares the four todo status values it accepts", () => {
    expect(SOURCE).toMatch(
      /export type TodoStatus =\s*"pending"\s*\|\s*"in_progress"\s*\|\s*"completed"\s*\|\s*"cancelled"/,
    )
  })

  test("maps completed to circle-check and other terminal states to circle", () => {
    expect(SOURCE).toMatch(/status === "completed"\s*\?\s*"circle-check"\s*:\s*"circle"/)
  })

  test("uses --icon-base for the fallback icon colour", () => {
    expect(SOURCE).toContain("var(--icon-base)")
  })

  test("renders the in-progress spinner as a 13×13 ring driven by --animate-pw-spin", () => {
    // The pixel values guard against an accidental size drift; the same
    // dimensions apply at every callsite.
    expect(SOURCE).toMatch(/width:\s*"13px"/)
    expect(SOURCE).toMatch(/height:\s*"13px"/)
    expect(SOURCE).toContain("--animate-pw-spin")
    expect(SOURCE).toContain("border-top-color")
    expect(SOURCE).toContain("var(--brand-primary)")
  })

  test("wraps the spinner ring inside a 16×16 inline-flex box", () => {
    // Outer wrapper matches the fallback Icon's 16×16 footprint so the marker
    // claims the same width regardless of state.
    expect(SOURCE).toMatch(/width:\s*"16px"/)
    expect(SOURCE).toMatch(/height:\s*"16px"/)
    expect(SOURCE).toContain('"inline-flex"')
  })

  test("applies the optional marginTop prop only when provided", () => {
    // Callers that need to align with the row's text baseline pass marginTop;
    // callsites with their own baseline (e.g. message-part todowrite) leave
    // it unset, so a literal "1px" default must NOT be baked into the source.
    expect(SOURCE).toMatch(/props\.marginTop\s*\?\s*\{\s*"margin-top":\s*props\.marginTop\s*\}\s*:\s*\{\}/)
    // Both the fallback Icon style and the spinner wrapper style must honour it.
    const occurrences = SOURCE.match(/"margin-top":\s*props\.marginTop/g) ?? []
    expect(occurrences.length).toBe(2)
  })
})
