import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("settings-general home suggestions row", () => {
  const source = readFileSync("src/components/settings-general.tsx", "utf8")

  test("renders the suggestion toggle row with the documented i18n title", () => {
    expect(source).toContain("settings.general.homeSuggestions")
  })

  test("wires the Switch to settings.general.homeSuggestionsEnabled accessor", () => {
    expect(source).toContain("settings.general.homeSuggestionsEnabled()")
    expect(source).toContain("settings.general.setHomeSuggestionsEnabled(")
  })

  test("restore button is gated on dismissed-non-empty (no useSync coupling)", () => {
    // dismissAll writes all chip ids, so dismissed-non-empty is true exactly
    // when chips were hidden via either path (per-row or section). For a
    // returning user the createEffect auto-latches seen=true but leaves
    // dismissed empty, so the button stays hidden and we never surface a
    // no-op recovery. This keeps Settings independent of the Sync provider,
    // which is critical because the Settings page renders outside it.
    expect(source).toContain("homeSuggestionsDismissed().length > 0")
    // Settings page renders outside the Sync provider; importing useSync
    // throws "Sync context must be used within a context provider".
    expect(source).not.toContain("useSync")
  })

  test("restore action resets BOTH dismissed and seen", () => {
    // The single most important invariant: clicking restore must clear BOTH
    // state slots, otherwise the button is a silent no-op after section X
    // (which writes both dismissed and seen).
    expect(source).toContain("setHomeSuggestionsDismissed([])")
    expect(source).toContain("setHomeSuggestionsSeen(false)")
  })

  test("switch toggle is a plain on/off without auto-clear side effects", () => {
    // The previous auto-clear-on-re-enable branch was dead code under the seen
    // flag (clearing dismissed did not restore chips). The dedicated restore
    // button now owns that responsibility; toggle stays simple.
    expect(source).not.toMatch(/setHomeSuggestionsEnabled\(checked\)[\s\S]{0,200}setHomeSuggestionsDismissed\(\[\]\)/)
  })
})
