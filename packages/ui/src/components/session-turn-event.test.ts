import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source-grep style tests; matches the message-part-stale convention.
// Behavioural placement (end-of-round vs after user message) is enforced
// by the SessionTurn agent round, not this component, so the tests here
// only pin the local invariants: kind taxonomy, label injection, and
// the visual contract (muted caption, no chrome).

const source = readFileSync(new URL("./session-turn-event.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./session-turn-event.css", import.meta.url), "utf8")

test("SystemEventKind predeclares the full W1 taxonomy even though only `interrupted` wires in 11b.1 (§3.5)", () => {
  expect(source).toMatch(/type SystemEventKind = "interrupted" \| "connection-lost" \| "connection-restored"/)
})

test("component is i18n-context-free — caller injects the resolved label as a prop", () => {
  // Must not import useLanguage / useI18n. Also must not reference
  // `i18n.t(...)` inline.
  expect(source).not.toMatch(/from "(\.\.\/context\/i18n|@kobalte\/core\/i18n)"/)
  expect(source).not.toMatch(/useI18n\(\)|useLanguage\(\)|i18n\.t\(/)
  expect(source).toMatch(/label: string/)
})

test("rendered DOM has a single muted caption, no icon, no prefix, no background, no border (DESIGN.md L475)", () => {
  expect(source).toMatch(/data-component="session-turn-event"[^>]*>[^<]*\{props\.label\}/)
  // No SVG / icon import / background / border in the source.
  expect(source).not.toMatch(/<Icon\b/)
  // CSS: only font + color + alignment, no background / border / padding.
  expect(css).toMatch(/\[data-component="session-turn-event"\][^{}]*\{[^}]*font:\s*var\(--type-caption\)[^}]*color:\s*var\(--fg-weak\)/)
  expect(css).not.toMatch(/\[data-component="session-turn-event"\][^{}]*\{[^}]*background/)
  expect(css).not.toMatch(/\[data-component="session-turn-event"\][^{}]*\{[^}]*border:/)
})

test("kind is surfaced as a data attribute so 11b.2's right-pane filters can target it without internal export", () => {
  expect(source).toMatch(/data-kind=\{props\.kind\}/)
})
