/**
 * Compaction UI behavioural contracts on session-turn.tsx — guards the
 * decisions in docs/superpowers/specs/2026-05-21-compaction-ui-design.md so
 * future edits cannot silently regress them. Renders nothing on purpose
 * (bun test resolves solid-js to its SSR no-op; createEffect won't fire), so
 * each contract is asserted against the source text instead of behaviour.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const turn = readFileSync(new URL("./session-turn.tsx", import.meta.url), "utf8")
const divider = readFileSync(new URL("./message-part/parts/compaction-and-divider.tsx", import.meta.url), "utf8")

test("raw and visible assistant message memos are split, summary stays only in raw", () => {
  expect(turn).toContain("const rawAssistantMessages = createMemo")
  expect(turn).toContain("const visibleAssistantMessages = createMemo")
  expect(turn).toMatch(/rawAssistantMessages\(\)\.filter\(\(m\)\s*=>\s*m\.summary\s*!==\s*true\)/)
})

test("compactionSummary uses the raw list (the only legitimate consumer of summary assistants)", () => {
  expect(turn).toContain("const compactionSummary = createMemo")
  expect(turn).toMatch(/rawAssistantMessages\(\)\.find\(\(m\)\s*=>\s*m\.summary\s*===\s*true\)/)
})

test("no remaining call site references the legacy `assistantMessages()` memo", () => {
  expect(turn).not.toMatch(/\bassistantMessages\(\)/)
})

test("every prior derivation now reads visibleAssistantMessages — leaks would silently surface the summary", () => {
  // turnInProgress / interrupted / error / showAssistantCopyPartID / turnDurationMs / assistantDerived / render
  const visibleCalls = turn.match(/visibleAssistantMessages\(\)/g)
  expect(visibleCalls?.length ?? 0).toBeGreaterThanOrEqual(7)
})

test("divider state machine reads from session-turn-compaction helpers and threads working()", () => {
  // isWorking (session busy/retry AND this is the active turn) disambiguates
  // "no summary yet" between the live race window and legacy orphans
  // (pre-PR pre-summary failures left no placeholder, even when the orphan
  // is the latest turn and a position-only heuristic would miss it).
  expect(turn).toContain("compactionDividerState({ summaryAssistant: compactionSummary(), isWorking: working() })")
  expect(turn).toContain("compactionDividerLabelKey({ state, error: summary?.error })")
})

test("showThinking suppresses while compaction divider is pending — divider already runs its own shimmer", () => {
  expect(turn).toMatch(/if\s*\(\s*compactionDivider\(\)\s*===\s*"pending"\s*\)\s*return\s*false/)
})

test("hideUserBody covers placeholder, replay flag, and 'every part is compaction_continue synthetic'", () => {
  // every(...) not some(...) — diagnostics reminders inject synthetic parts too
  expect(turn).toContain("const hideUserBody = createMemo")
  expect(turn).toContain('ps[0]?.type === "compaction"')
  expect(turn).toContain("msg.replay === true")
  expect(turn).toMatch(/ps\.every\(/)
  expect(turn).not.toMatch(/ps\.some\(/)
  expect(turn).toContain("compaction_continue")
  expect(turn).toContain("part.synthetic === true")
})

test("turn row is preserved — only the inner message-content body hides", () => {
  // hideUserBody guards Message rendering; the surrounding session-turn-message-container stays so
  // child assistants attached via parentID keep their render slot.
  expect(turn).toMatch(/Show when=\{!hideUserBody\(\)\}>\s*<div data-slot="session-turn-message-content"/)
  expect(turn).toContain('data-slot="session-turn-message-container"')
})

test("error card source ignores summary assistants (failed compaction never doubles up)", () => {
  // error() pulls from visibleAssistantMessages — summary is filtered there.
  expect(turn).toMatch(/visibleAssistantMessages\(\)\.find\(\(m\)\s*=>\s*m\.error\s*&&\s*m\.error\.name\s*!==\s*"MessageAbortedError"\s*\)/)
})

test("compaction elapsed signal cleans up its interval when state leaves pending or component unmounts", () => {
  expect(turn).toContain("const [compactionElapsedSec, setCompactionElapsedSec] = createSignal(0)")
  expect(turn).toContain("setInterval")
  expect(turn).toContain("onCleanup(() => clearInterval(interval))")
  // Reset to 0 on non-pending so the timer doesn't stick.
  expect(turn).toMatch(/state\s*!==\s*"pending".*setCompactionElapsedSec\(0\)/s)
})

test("MessageDivider renders icons through the real icon registry, not inline SVG", () => {
  expect(divider).toContain('Icon name="circle-ban-sign"')
  expect(divider).toContain('Icon name="circle-x"')
  expect(divider).toContain("TextShimmer text={props.label} active={true}")
})

test("MessageDivider exposes data-state for the four-state stylesheet (default stays 'static')", () => {
  expect(divider).toContain('data-state={state() ?? "static"}')
})

test("registered compaction-part component still falls back to the static done label so the part-registry contract holds", () => {
  expect(divider).toContain('registerPartComponent("compaction"')
  expect(divider).toContain('i18n.t("ui.messagePart.compaction")')
})
