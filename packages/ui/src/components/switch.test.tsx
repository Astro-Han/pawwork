import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("./switch.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./switch.css", import.meta.url), "utf8")

// ── slot / data-attribute contract ──────────────────────────────────────────

test("renders with data-component=switch on root", () => {
  expect(src).toContain('data-component="switch"')
})

test("data-slot=switch-control exists (track element)", () => {
  expect(src).toContain('data-slot="switch-control"')
})

test("data-slot=switch-thumb exists", () => {
  expect(src).toContain('data-slot="switch-thumb"')
})

test("data-slot=switch-input exists (hidden checkbox for aria-checked)", () => {
  expect(src).toContain('data-slot="switch-input"')
})

test("data-slot=switch-label exists", () => {
  expect(src).toContain('data-slot="switch-label"')
})

// ── label and description ────────────────────────────────────────────────────

test("description prop is declared in SwitchProps", () => {
  expect(src).toMatch(/description\?\s*:\s*string/)
})

test("Kobalte.Description is used for description slot", () => {
  expect(src).toContain("Kobalte.Description")
})

// ── controlled: Kobalte forwards checked → aria-checked on input ─────────────

test("Kobalte.Input is used (Kobalte handles aria-checked reflection)", () => {
  // Kobalte.Switch renders the input with aria-checked automatically;
  // the component must delegate to Kobalte.Input, not a raw <input>
  expect(src).toContain("Kobalte.Input")
})

// ── disabled: Kobalte.Switch disabled prop is forwarded via ...others ─────────

test("disabled state is forwarded via ...others spread to Kobalte root", () => {
  // Switch uses {...others} spread so disabled is passed through to Kobalte
  expect(src).toContain("{...others}")
})

// ── CSS: pill shape (9999px) ─────────────────────────────────────────────────

test("switch-control uses border-radius 9999px (pill track)", () => {
  expect(css).toContain("border-radius: 9999px")
})

// ── CSS: thumb size 12x12 ────────────────────────────────────────────────────

test("switch-thumb is 12px wide", () => {
  // CSS should declare 12px width for the thumb
  const thumbSection = css.slice(css.indexOf('switch-thumb"'))
  expect(thumbSection).toMatch(/width:\s*12px/)
})

test("switch-thumb is 12px tall", () => {
  const thumbSection = css.slice(css.indexOf('switch-thumb"'))
  expect(thumbSection).toMatch(/height:\s*12px/)
})

// ── CSS: checked state uses brand-primary ────────────────────────────────────

test("checked track background uses --brand-primary", () => {
  expect(css).toContain("var(--brand-primary)")
})

// ── CSS: duration tokens instead of literals ─────────────────────────────────

test("CSS uses duration tokens not raw 150ms literals in transitions", () => {
  // After rewrite, 150ms literals should be replaced with CSS var tokens
  const literalMatches = css.match(/\b150ms\b/g) ?? []
  expect(literalMatches.length).toBe(0)
})

// ── CSS: translate distance for 28px track, 12px thumb, 1px padding ───────────

test("checked thumb translate is 14px (28 - 12 - 1 - 1)", () => {
  expect(css).toContain("translateX(14px)")
})
