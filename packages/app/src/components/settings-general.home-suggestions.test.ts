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

  test("restore button is visible whenever any chip is dismissed OR seen was set", () => {
    // Either source slot indicates "chips are currently hidden because of past
    // user action" and a restore should be offered. Gating only on dismissed
    // would leave the button hidden after a section dismiss (which writes seen).
    expect(source).toContain("homeSuggestionsDismissed().length > 0")
    expect(source).toContain("homeSuggestionsSeen()")
  })

  test("restore action resets BOTH dismissed and seen", () => {
    // The single most important invariant: clicking restore must clear BOTH
    // state slots, otherwise the button is a silent no-op after section X.
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
