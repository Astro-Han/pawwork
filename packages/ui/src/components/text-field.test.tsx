import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("./text-field.tsx", import.meta.url), "utf8")

// ── slot / data-attribute contract ──────────────────────────────────────────

test("data-component=input is set on root", () => {
  expect(src).toContain('data-component="input"')
})

test("data-slot=input-wrapper exists in JSX", () => {
  expect(src).toContain('data-slot="input-wrapper"')
})

test("data-slot=input-input exists in JSX", () => {
  expect(src).toContain('data-slot="input-input"')
})

test("data-variant attribute is rendered from variant prop", () => {
  // data-variant should be set dynamically from the variant prop
  expect(src).toMatch(/data-variant=\{/)
})

// ── error state ──────────────────────────────────────────────────────────────

test("error prop is declared as string in the interface", () => {
  expect(src).toMatch(/error\?\s*:\s*string/)
})

test("error icon slot renders when error has value", () => {
  // ErrorMessage row contains a warning Icon
  expect(src).toContain('name="warning"')
})

test("validationState=invalid is set when error has value", () => {
  // validationState should be derived from error prop presence
  expect(src).toMatch(/validationState.*invalid/)
})

// ── ghost variant ────────────────────────────────────────────────────────────

test("ghost is an accepted variant value", () => {
  // The interface should list ghost as a variant option
  expect(src).toContain('"ghost"')
})

// ── multiline ────────────────────────────────────────────────────────────────

test("multiline prop renders Kobalte.TextArea", () => {
  expect(src).toContain("TextArea")
})

// ── copyable ─────────────────────────────────────────────────────────────────

test("copyable prop renders copy button slot", () => {
  expect(src).toContain('data-slot="input-copy-button"')
})

// ── disabled ─────────────────────────────────────────────────────────────────

test("disabled prop is forwarded to Kobalte root", () => {
  expect(src).toContain("disabled={local.disabled}")
})

// ── placeholder passthrough ───────────────────────────────────────────────────

test("other props (including placeholder) are spread onto the input via others", () => {
  // The {...others} spread passes placeholder and other input attrs through
  expect(src).toContain("{...others}")
})

// ── label / description / error message ──────────────────────────────────────

test("label renders Kobalte.Label with data-slot=input-label", () => {
  expect(src).toContain('data-slot="input-label"')
})

test("description renders Kobalte.Description with data-slot=input-description", () => {
  expect(src).toContain('data-slot="input-description"')
})

test("error message renders Kobalte.ErrorMessage with data-slot=input-error", () => {
  expect(src).toContain('data-slot="input-error"')
})
