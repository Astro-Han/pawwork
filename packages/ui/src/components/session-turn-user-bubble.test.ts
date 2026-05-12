import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// Source-grep style tests, matching the message-part-stale convention.
// Full behavioural coverage (hover toolbar reveal, clipboard write,
// SDK reset path) comes through the dev:desktop manual checklist
// (D2 / D8 / D9) and the E2E suite (E1 / E7 / E9). These tests pin
// the structural invariants that the slice 11b.1 design doc names by
// number, so a regression that drops one of them surfaces immediately.

const source = readFileSync(new URL("./session-turn-user-bubble.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./session-turn-user-bubble.css", import.meta.url), "utf8")

test("bubble joins multiple non-synthetic text parts with a double newline (§3.3)", () => {
  expect(source).toMatch(/\.filter\(\(p\): p is TextPart => p\.type === "text" && !\(p as TextPart\)\.synthetic\)/)
  expect(source).toMatch(/join\("\\n\\n"\)/)
})

test("bubble text uses plain JSX interpolation, not innerHTML — XSS-safe (§6.15)", () => {
  expect(source).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/)
  expect(source).toMatch(/data-slot="bubble-text">\{bubbleText\(\)\}/)
})

test("attachment row consumes shared AttachmentChip with `removable={false}` (§3.7)", () => {
  expect(source).toMatch(/from "\.\/attachment-chip"/)
  expect(source).toMatch(/<AttachmentChip[\s\S]*?removable=\{false\}/)
})

test("bubble toolbar is always mounted — no <Show when=hover> wrapper around it (§3.6)", () => {
  // The toolbar block must sit at the JSX top level of the component,
  // not under a `<Show when={hovered}>`; visibility is CSS-only so
  // keyboard `:focus-within` can actually find a button to focus.
  expect(source).toMatch(/<div[^>]*data-slot="bubble-toolbar">/)
  expect(source).not.toMatch(/<Show when=\{hovered\}[\s\S]*data-slot="bubble-toolbar"/)
})

test("reset action enters in-flight disabled state (§6.14 rapid-click guard)", () => {
  expect(source).toMatch(/const \[resetting, setResetting\] = createSignal\(false\)/)
  expect(source).toMatch(/if \(resetting\(\) \|\| !props\.actions\?\.onReset\) return/)
  expect(source).toMatch(/disabled=\{resetting\(\)\}/)
})

test("copy action runs through onCopy override before falling back to navigator.clipboard (§6.13)", () => {
  expect(source).toMatch(/if \(props\.actions\?\.onCopy\)/)
  expect(source).toMatch(/await props\.actions\.onCopy\(text\)/)
  expect(source).toMatch(/await navigator\.clipboard\.writeText\(text\)/)
})

test("time stamp uses local 24h `HH:mm`; full timestamp on `title` (§2)", () => {
  expect(source).toMatch(/hour: "2-digit"[\s\S]*minute: "2-digit"[\s\S]*hour12: false/)
  expect(source).toMatch(/data-slot="bubble-toolbar-time" title=\{timeTitle\(\)\}/)
})

test("CSS bubble matches W1 lock: radius-lg + bg-cream + padding 12/16", () => {
  expect(css).toMatch(/\[data-slot="bubble"\][^{}]*\{[^}]*border-radius:\s*var\(--radius-lg\)/)
  expect(css).toMatch(/\[data-slot="bubble"\][^{}]*\{[^}]*background:\s*var\(--bg-cream\)/)
  expect(css).toMatch(/\[data-slot="bubble"\][^{}]*\{[^}]*padding:\s*12px\s+16px/)
})

test("CSS wrap is right-aligned and capped at 75% of timeline column (§3.3 / DESIGN.md L453)", () => {
  expect(css).toMatch(
    /\[data-component="session-turn-user-bubble"\][^{}]*\{[^}]*align-self:\s*flex-end[^}]*max-width:\s*75%/,
  )
})

test("CSS bubble-text uses pre-wrap so `\\n\\n` paragraphs render verbatim (§3.3)", () => {
  expect(css).toMatch(/\[data-slot="bubble-text"\][^{}]*\{[^}]*white-space:\s*pre-wrap/)
})

test("CSS toolbar visibility OR-combines hover / focus-within / data-hover (§3.6 / §6.18)", () => {
  // Default invisible + inert.
  expect(css).toMatch(/\[data-slot="bubble-toolbar"\][^{}]*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/)
  // Three trigger surfaces.
  expect(css).toMatch(/:hover\s+\[data-slot="bubble-toolbar"\]/)
  expect(css).toMatch(/:focus-within\s+\[data-slot="bubble-toolbar"\]/)
  expect(css).toMatch(/\[data-hover\]\s+\[data-slot="bubble-toolbar"\]/)
})

test("CSS toolbar gap spec: 12 between meta+actions, 8 inside meta, 4 inside actions (§3.6 / W1)", () => {
  expect(css).toMatch(/\[data-slot="bubble-toolbar"\][^{}]*\{[^}]*gap:\s*12px/)
  expect(css).toMatch(/\[data-slot="bubble-toolbar-meta"\][^{}]*\{[^}]*gap:\s*8px/)
  expect(css).toMatch(/\[data-slot="bubble-toolbar-actions"\][^{}]*\{[^}]*gap:\s*4px/)
})
