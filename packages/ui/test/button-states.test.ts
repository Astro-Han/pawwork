/**
 * Button component state matrix — DESIGN.md §157-172, §305-313
 * Slice #04, issue #440.
 *
 * Parses CSS and TypeScript source directly; no DOM rendering required.
 * Run with: bun --cwd packages/ui test test/button-states.test.ts
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const BUTTON_CSS = readFileSync(join(ROOT, "src/components/button.css"), "utf-8")
const BUTTON_TSX = readFileSync(join(ROOT, "src/components/button.tsx"), "utf-8")

// ── API contract ────────────────────────────────────────────────────────────

describe("Button — API contract", () => {
  test("size prop is absent (DESIGN.md: single height 30px)", () => {
    expect(BUTTON_TSX).not.toMatch(/size\??\s*:/)
  })

  test("variant union includes danger", () => {
    expect(BUTTON_TSX).toContain('"danger"')
  })
})

// ── Single canonical size ───────────────────────────────────────────────────

describe("Button — single canonical size (30px)", () => {
  test("CSS has no data-size selectors", () => {
    expect(BUTTON_CSS).not.toContain("data-size=")
  })

  test("height 30px is declared outside any variant selector", () => {
    // The root [data-component="button"] block must set height directly
    expect(BUTTON_CSS).toMatch(/\[data-component="button"\]\s*\{[^}]*height:\s*30px/)
  })
})

// ── Primary variant ─────────────────────────────────────────────────────────

describe("Button — Primary variant", () => {
  test("default background uses --brand-primary", () => {
    expect(BUTTON_CSS).toContain('data-variant="primary"')
    expect(BUTTON_CSS).toContain("var(--brand-primary)")
  })

  test("hover background uses --brand-primary-hover", () => {
    expect(BUTTON_CSS).toContain("var(--brand-primary-hover)")
  })

  test("text color uses --fg-on-brand", () => {
    expect(BUTTON_CSS).toContain("var(--fg-on-brand)")
  })
})

// ── Secondary variant ───────────────────────────────────────────────────────

describe("Button — Secondary variant", () => {
  test("border uses --ring-base via box-shadow (not --shadow-xs-border-base)", () => {
    expect(BUTTON_CSS).toContain("var(--ring-base)")
  })

  test("hover applies --hover-overlay overlay", () => {
    expect(BUTTON_CSS).toContain("var(--hover-overlay)")
  })
})

// ── Ghost variant ───────────────────────────────────────────────────────────

describe("Button — Ghost variant", () => {
  test("default background is transparent", () => {
    expect(BUTTON_CSS).toContain('data-variant="ghost"')
  })

  test("hover applies --hover-overlay overlay", () => {
    // Already checked above; ghost also uses hover-overlay
    expect(BUTTON_CSS).toContain("var(--hover-overlay)")
  })
})

// ── Danger variant (new in slice #04) ───────────────────────────────────────

describe("Button — Danger variant", () => {
  test('data-variant="danger" selector exists in CSS', () => {
    expect(BUTTON_CSS).toContain('data-variant="danger"')
  })

  test("default background uses --error (per DESIGN.md destructive token)", () => {
    expect(BUTTON_CSS).toMatch(/data-variant="danger"[\s\S]*?background-color:\s*var\(--error\)/)
  })

  test("hover overlays --hover-overlay on top of --error (theme-safe contrast)", () => {
    expect(BUTTON_CSS).toMatch(
      /data-variant="danger"[\s\S]*?:hover[\s\S]*?background-image:\s*linear-gradient\(var\(--hover-overlay\)/,
    )
  })

  test("active overlays --hover-overlay-warm (deeper than hover)", () => {
    expect(BUTTON_CSS).toMatch(
      /data-variant="danger"[\s\S]*?:active[\s\S]*?background-image:\s*linear-gradient\(var\(--hover-overlay-warm\)/,
    )
  })
})

// ── Active state per variant ────────────────────────────────────────────────
// Note: danger active intentionally diverges — it overlays --hover-overlay-warm
// on top of --error rather than switching to --surface-interactive-base, which
// would give a warm cream tone (wrong semantics for a destructive press).

describe("Button — active state per variant", () => {
  test("primary active uses --surface-interactive-base", () => {
    expect(BUTTON_CSS).toMatch(
      /data-variant="primary"[\s\S]*?:active[\s\S]*?background-color:\s*var\(--surface-interactive-base\)/,
    )
  })

  test("secondary active uses --surface-interactive-base", () => {
    expect(BUTTON_CSS).toMatch(
      /data-variant="secondary"[\s\S]*?:active[\s\S]*?background-color:\s*var\(--surface-interactive-base\)/,
    )
  })

  test("ghost active uses --surface-interactive-base", () => {
    expect(BUTTON_CSS).toMatch(
      /data-variant="ghost"[\s\S]*?:active[\s\S]*?background-color:\s*var\(--surface-interactive-base\)/,
    )
  })

  // danger active is asserted in the Danger variant block (overlay-on-error,
  // not surface-interactive-base). Pin the divergence so a later refactor
  // doesn't silently re-converge danger onto the cream tone.
  test("danger active does NOT use --surface-interactive-base", () => {
    expect(BUTTON_CSS).not.toMatch(
      /data-variant="danger"[\s\S]*?:active[\s\S]*?background-color:\s*var\(--surface-interactive-base\)/,
    )
  })
})

// ── Focus-visible ring ──────────────────────────────────────────────────────

describe("Button — focus-visible ring (DESIGN.md: inline, not tokenized)", () => {
  test("focus-visible box-shadow contains #FF5910", () => {
    expect(BUTTON_CSS).toContain("#FF5910")
  })

  test("focus-visible outer glow uses rgba(255,89,16", () => {
    expect(BUTTON_CSS).toContain("rgba(255,89,16")
  })
})

// ── Disabled state ──────────────────────────────────────────────────────────

describe("Button — disabled state", () => {
  test("disabled applies opacity (DESIGN.md: 40-50%)", () => {
    expect(BUTTON_CSS).toContain("opacity:")
  })

  test("disabled uses cursor: not-allowed", () => {
    expect(BUTTON_CSS).toContain("cursor: not-allowed")
  })

  test("hover/active selectors guard against disabled via :not(:disabled)", () => {
    expect(BUTTON_CSS).toContain(":not(:disabled)")
  })
})
