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

  test("exposes a restore-all button gated by all-three-dismissed state", () => {
    expect(source).toContain("settings.general.homeSuggestionsDismissed().length >= 3")
    expect(source).toContain("settings.general.setHomeSuggestionsDismissed([])")
  })

  test("clears dismissed list when re-enabling and previously all-dismissed", () => {
    expect(source).toMatch(/setHomeSuggestionsEnabled\(checked\)[\s\S]{0,400}setHomeSuggestionsDismissed\(\[\]\)/)
  })
})
