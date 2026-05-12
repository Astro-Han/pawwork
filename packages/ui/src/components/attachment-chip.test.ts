import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source-grep style tests, matching the repo convention used by
// message-part-stale.test.ts. The full behavioural / removable-vs-read-only
// matrix is covered by session-turn-user-bubble.test.tsx (Phase 2c) and the
// dev:desktop D2 manual check. Tests here pin the structural invariants the
// design doc §3.7 calls out.

const source = readFileSync(new URL("./attachment-chip.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./attachment-chip.css", import.meta.url), "utf8")

test("attachment-chip is the shared primitive (one component, file + image)", () => {
  // One component name, two visual kinds via data-kind, gated by removable.
  expect(source).toMatch(/export function AttachmentChip\(/)
  expect(source).toMatch(/data-kind="file"/)
  expect(source).toMatch(/data-kind="image"/)
})

test("attachment-chip × close button is gated by `removable` prop", () => {
  // The Show wrappers around the remove button must use props.removable
  // (DESIGN.md L460, message-flow.html L1088: bubble never renders ×).
  expect(source).toMatch(/<Show when=\{props\.removable\}>/)
  // And the close button glyph must use the existing chrome icon.
  expect(source).toMatch(/<Icon name="close" \/>/)
})

test("attachment-chip file-kind exposes name + ext slots (W1 right column)", () => {
  expect(source).toMatch(/data-slot="attachment-chip-name"/)
  expect(source).toMatch(/data-slot="attachment-chip-ext"/)
})

test("CSS geometry matches W1 lock: file chip h64 / radius-md / max-width 280", () => {
  // Pin the visual contract — these three values are the ones the W1
  // preview lock-stamp calls out by name.
  expect(css).toMatch(/\[data-component="attachment-chip"\][^{}]*\{[^}]*max-width:\s*280px/)
  expect(css).toMatch(/\[data-kind="file"\][^{}]*\{[^}]*height:\s*64px/)
  expect(css).toMatch(/\[data-kind="file"\][^{}]*\{[^}]*border-radius:\s*var\(--radius-md\)/)
})

test("CSS image-kind: 64×64 square + radius-md + object-fit cover", () => {
  expect(css).toMatch(/\[data-kind="image"\][^{}]*\{[^}]*width:\s*64px[^}]*height:\s*64px/)
  expect(css).toMatch(/\[data-kind="image"\][^}]*\}\s*\n\s*\[data-component="attachment-chip"\]\[data-kind="image"\][^{}]*\[data-slot="attachment-chip-image"\][^{}]*\{[^}]*object-fit:\s*cover/)
})

test("CSS remove button floats top-right with 24-circle + brand-color hairline ring on focus", () => {
  expect(css).toMatch(/\[data-slot="attachment-chip-remove"\][^{}]*\{[^}]*top:\s*-6px[^}]*right:\s*-6px/)
  expect(css).toMatch(/\[data-slot="attachment-chip-remove"\][^{}]*\{[^}]*width:\s*24px[^}]*height:\s*24px/)
  expect(css).toMatch(/\[data-slot="attachment-chip-remove"\]:focus-visible[^{}]*\{[^}]*var\(--brand-primary\)/)
})
