import { expect, test, describe } from "bun:test"
import { readFileSync } from "node:fs"

const rawSource = readFileSync(new URL("./session-turn-v2.tsx", import.meta.url), "utf8")
const rawCss = readFileSync(new URL("./session-turn-v2.css", import.meta.url), "utf8")

/**
 * Strip block comments + line comments from a TS source so the "must
 * not appear" assertions don't false-positive on the file-header
 * deferral note. Keeps strings intact (the assertions below check
 * actual JSX / identifier usage).
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

const source = stripComments(rawSource)
const css = stripComments(rawCss)

// ============================================================================
// Source-grep invariants — slice 11b.1 PR #589 Status section locks the
// hybrid opt-in contract. These tests are the compile-time evidence that
// the file actually behaves the way the PR body promises.
// ============================================================================

describe("session-turn-v2 hybrid shell", () => {
  test("marks itself with the opt-in data-component attribute (PR #589 Status)", () => {
    expect(source).toMatch(/data-component="session-turn-v2"/)
  })

  test("does not own a new mount point — host SessionTurn is still default", () => {
    // The shell must not register a global event listener or window-scoped
    // mount hook. It is a pure JSX component the host opts into by import.
    expect(source).not.toMatch(/window\.addEventListener|document\.addEventListener/)
  })

  test("wires the three new leaf components (user bubble + agent round)", () => {
    expect(source).toMatch(/<SessionTurnUserBubble\b/)
    expect(source).toMatch(/<SessionTurnAgentRound\b/)
  })

  test("delegates prose rendering to the existing markdown stack via renderProse slot", () => {
    // The leaf is context-free; the dispatcher injects <Markdown>.
    expect(source).toMatch(/from "\.\/markdown"/)
    expect(source).toMatch(/renderProse[\s\S]*<Markdown\b/)
  })

  test("pre-resolves labels through useI18n so the leaves stay context-free", () => {
    expect(source).toMatch(/from "\.\.\/context\/i18n"/)
    expect(source).toMatch(/i18n\.t\("ui\.message\.copy"\)/)
    expect(source).toMatch(/i18n\.t\("ui\.message\.copied"\)/)
    expect(source).toMatch(/i18n\.t\("ui\.message\.forkMessage"\)/)
    expect(source).toMatch(/i18n\.t\("ui\.message\.interrupted"\)/)
    expect(source).toMatch(/i18n\.t\("ui\.sessionTurnV2\.workingTime"/)
    expect(source).toMatch(/i18n\.t\("ui\.sessionTurnV2\.trow\.running"/)
  })

  test("does not re-implement turnChanges / diffs / retry / error / compaction (deferred to sibling slice)", () => {
    expect(source).not.toMatch(/turnChange|TurnChange/)
    expect(source).not.toMatch(/SessionRetry/)
    expect(source).not.toMatch(/DiffChanges/)
    expect(source).not.toMatch(/MessageDivider/)
    // The deferral note must be in the raw file header so future readers
    // know why these are missing — checked against the un-stripped source.
    expect(rawSource).toMatch(/Deferred to sibling slice/)
  })

  test("translates the existing UserActions shape into the leaf 0-arg async handlers", () => {
    // Leaf onReset / onFork are 0-arg; the SDK SessionAction takes
    // { sessionID, messageID }. The dispatcher must adapt both sides.
    expect(source).toMatch(/onReset:[\s\S]*props\.actions\?\.revert\?\.\(/)
    expect(source).toMatch(/onFork:[\s\S]*props\.actions\?\.fork\?\.\(/)
  })

  test("isLatestRound is derived from the last user message in the session (round-tick gate)", () => {
    // Only the latest round may keep ticking — older rounds freeze at
    // their final elapsed value. The dispatcher must compute this.
    expect(source).toMatch(/isLatestRound/)
    expect(source).toMatch(/lastUserID/)
  })

  test("css uses --bg-base + 24px gap, no turn-frame (DESIGN.md L463-L469)", () => {
    expect(css).toMatch(/background:\s*var\(--bg-base\)/)
    expect(css).toMatch(/gap:\s*24px/)
    // No turn-frame wrapper — DESIGN.md L463 explicitly flat.
    expect(css).not.toMatch(/turn-frame|--bg-frame/)
  })
})
