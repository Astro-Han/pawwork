/**
 * IconButton component contract — DESIGN.md §157-172 (icon button spec)
 * Slice #04, issue #440.
 *
 * Key spec: 24×24, ghost-only, radius-sm. Forbidden: size prop, iconSize prop,
 * variant primary/secondary. titlebar-icon (32×24) is the sole authorised exception.
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

describe("IconButton — single canonical size (24×24)", () => {
  test("no data-size selectors in CSS", () => {
    expect(CSS).not.toContain("data-size=")
  })

  test("width 24px declared at root level", () => {
    expect(CSS).toMatch(/\[data-component="icon-button"\]\s*\{[^}]*width:\s*24px/)
  })

  test("height 24px declared at root level", () => {
    expect(CSS).toMatch(/\[data-component="icon-button"\]\s*\{[^}]*height:\s*24px/)
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

  test("hover applies --hover-overlay token", () => {
    expect(CSS).toContain("var(--hover-overlay)")
  })

  test("active state uses --surface-interactive-base", () => {
    expect(CSS).toContain("var(--surface-interactive-base)")
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

describe("IconButton — titlebar-icon exception (DESIGN.md §172)", () => {
  test(".titlebar-icon override is preserved", () => {
    expect(CSS).toContain("titlebar-icon")
  })

  test(".titlebar-icon is 32×24 (not square)", () => {
    expect(CSS).toContain("width: 32px")
    expect(CSS).toContain("aspect-ratio: auto")
  })
})
