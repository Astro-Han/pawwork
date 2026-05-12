import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source-grep style tests. Behavioural coverage (scroll-up → button →
// click → scrolls to bottom and hides) lives in E2E E6 and the
// dev:desktop D6 manual check. Tests here pin local structural
// invariants that the design doc names.

const source = readFileSync(new URL("./session-turn-jump.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./session-turn-jump.css", import.meta.url), "utf8")

test("button is presentational — props-only, no scroll state owned here (§3.4 / §1)", () => {
  expect(source).toContain("visible: boolean")
  expect(source).toContain("onClick: () => void")
  // Must not import scroll hooks / createAutoScroll inside the component
  // (the JSDoc comment may name them as the consumer, but the code body
  // must not pull them in — they live in packages/app).
  expect(source).not.toMatch(/^import [^\n]*createAutoScroll/m)
  expect(source).not.toMatch(/^import [^\n]*useTimelineScroll/m)
})

test("visibility gated by `visible` prop only — single-signal rule (§3.4)", () => {
  // No `hasNewContentSinceUnlock` style gating in the component.
  expect(source).toMatch(/<Show when=\{props\.visible\}>/)
  expect(source).not.toMatch(/hasNewContent|sinceUnlock/)
})

test("uses `chevron-down` 16-px glyph (DESIGN.md L477)", () => {
  expect(source).toMatch(/<Icon name="chevron-down" \/>/)
  expect(css).toMatch(/\[data-component="session-turn-jump"\]\s+\[data-icon\][^{}]*\{[^}]*width:\s*16px[^}]*height:\s*16px/)
})

test("CSS geometry matches round floating variant: 30×30 / pill radius / surface-raised / shadow-floating", () => {
  expect(css).toMatch(
    /\[data-component="session-turn-jump"\][^{}]*\{[^}]*width:\s*30px[^}]*height:\s*30px[^}]*border-radius:\s*9999px[^}]*background:\s*var\(--surface-raised\)[^}]*box-shadow:\s*var\(--shadow-floating\)/,
  )
})

test("focus-visible adds brand ring on top of the floating shadow, not replacing it", () => {
  expect(css).toMatch(
    /\[data-component="session-turn-jump"\]:focus-visible[^{}]*\{[^}]*box-shadow:\s*[^;]*var\(--shadow-floating\)[\s\S]*var\(--brand-primary\)/,
  )
})
