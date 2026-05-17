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

  test("exposes a restore button whenever any chip is dismissed (not only all-dismissed)", () => {
    expect(source).toContain("homeSuggestionsDismissed().length > 0")
    expect(source).toContain("settings.general.setHomeSuggestionsDismissed([])")
  })

  test("uses HOME_SUGGESTION_CHIPS.length for the all-dismissed gate (not a hardcoded count)", () => {
    expect(source).toContain("HOME_SUGGESTION_CHIPS.length")
    expect(source).not.toMatch(/homeSuggestionsDismissed\(\)\.length\s*>=\s*3\b/)
  })

  test("clears dismissed list when re-enabling and previously all-dismissed", () => {
    expect(source).toMatch(/setHomeSuggestionsEnabled\(checked\)[\s\S]{0,400}setHomeSuggestionsDismissed\(\[\]\)/)
  })
})
