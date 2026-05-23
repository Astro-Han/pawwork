/**
 * IconButton component contract — DESIGN.md §157-172 (icon button spec)
 * Slice #04, issue #440.
 *
 * Key spec: 30×30, ghost-only, radius-md. Forbidden: size prop, iconSize prop,
 * variant primary/secondary. titlebar-icon (32×30) is the sole authorised exception.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const CSS = readFileSync(join(ROOT, "src/components/icon-button.css"), "utf-8")
const TSX = readFileSync(join(ROOT, "src/components/icon-button.tsx"), "utf-8")

// ── API contract ────────────────────────────────────────────────────────────

describe("IconButton — API contract", () => {
  test("size prop is absent (DESIGN.md: forbids size prop)", () => {
    expect(TSX).not.toMatch(/size\??\s*:/)
  })

  test("iconSize prop is absent (DESIGN.md: forbids iconSize prop)", () => {
    expect(TSX).not.toContain("iconSize")
  })

  test("variant prop is absent (ghost-only, fixed by DESIGN.md)", () => {
    expect(TSX).not.toMatch(/variant\??\s*:/)
  })
})

// ── Single canonical size ───────────────────────────────────────────────────

describe("IconButton — single canonical size (30×30)", () => {
  test("no data-size selectors in CSS", () => {
    expect(CSS).not.toContain("data-size=")
  })

  test("width 30px declared at root level", () => {
    expect(CSS).toMatch(/\[data-component="icon-button"\]\s*\{[^}]*width:\s*30px/)
  })

  test("height 30px declared at root level", () => {
    expect(CSS).toMatch(/\[data-component="icon-button"\]\s*\{[^}]*height:\s*30px/)
  })

  test("base border-radius is radius-md (DESIGN.md §342)", () => {
    expect(CSS).toMatch(/\[data-component="icon-button"\]\s*\{[^}]*border-radius:\s*var\(--radius-md\)/)
  })
})

// ── Ghost-only behaviour ────────────────────────────────────────────────────

describe("IconButton — ghost-only", () => {
  test("no primary variant selector in CSS", () => {
    expect(CSS).not.toContain('data-variant="primary"')
  })

  test("no secondary variant selector in CSS", () => {
    expect(CSS).not.toContain('data-variant="secondary"')
  })

  test("default background is transparent", () => {
    expect(CSS).toContain("background-color: transparent")
  })

  test("base hover applies --hover-overlay token", () => {
    expect(CSS).toMatch(
      /&:hover:not\(:disabled\)\s*\{[^}]*background-color:\s*var\(--hover-overlay\)/,
    )
  })

  test("active state uses --surface-interactive-base", () => {
    expect(CSS).toContain("var(--surface-interactive-base)")
  })

  test("sidebar row menu trigger overrides to --row-active-overlay (slice 09)", () => {
    expect(CSS).toMatch(
      /\[data-component="pawwork-session-row"\]\s*\[data-action="session-row-menu"\]\[data-component="icon-button"\]/,
    )
    expect(CSS).toMatch(/var\(--row-active-overlay\)/)
  })
})

// ── Focus-visible ring ──────────────────────────────────────────────────────

describe("IconButton — focus-visible ring", () => {
  test("focus-visible box-shadow contains #FF5910", () => {
    expect(CSS).toContain("#FF5910")
  })
})

// ── Disabled state ──────────────────────────────────────────────────────────

describe("IconButton — disabled state", () => {
  test("disabled applies opacity", () => {
    expect(CSS).toContain("opacity:")
  })

  test("disabled uses cursor: not-allowed", () => {
    expect(CSS).toContain("cursor: not-allowed")
  })
})

// ── titlebar-icon exception ─────────────────────────────────────────────────

describe("IconButton — titlebar-icon exception (DESIGN.md §346)", () => {
  test(".titlebar-icon override is preserved", () => {
    expect(CSS).toContain("titlebar-icon")
  })

  test(".titlebar-icon is 32×30 (not square)", () => {
    expect(CSS).toContain("width: 32px")
    expect(CSS).toContain("height: 30px")
    expect(CSS).toContain("aspect-ratio: auto")
  })
})
