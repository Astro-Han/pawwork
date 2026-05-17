import { describe, expect, test } from "bun:test"
import {
  HOME_SUGGESTION_CHIPS,
  resolveVisibleHomeSuggestions,
  type HomeSuggestionChipID,
} from "./home-suggestions-state"

describe("resolveVisibleHomeSuggestions", () => {
  const allIDs = HOME_SUGGESTION_CHIPS.map((chip) => chip.id)

  test("returns all chips for a first-time visitor with nothing dismissed", () => {
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: true, dismissed: [] })).toEqual(allIDs)
  })

  test("returns empty when not a first-time visitor", () => {
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: false, dismissed: [] })).toEqual([])
  })

  test("filters dismissed chips while preserving original order", () => {
    const dismissed: HomeSuggestionChipID[] = ["excel-analysis"]
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: true, dismissed })).toEqual(
      allIDs.filter((id) => id !== "excel-analysis"),
    )
  })

  test("returns empty when all three chips are dismissed", () => {
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: true, dismissed: allIDs })).toEqual([])
  })

  test("HOME_SUGGESTION_CHIPS has stable IDs and three entries", () => {
    expect(HOME_SUGGESTION_CHIPS).toHaveLength(3)
    expect(allIDs).toEqual(["folder-organize", "excel-analysis", "ppt-outline"])
  })

  test("each chip exposes stable label and prompt i18n keys", () => {
    for (const chip of HOME_SUGGESTION_CHIPS) {
      expect(chip.labelKey).toMatch(/^home\.suggestion\..+\.label$/)
      expect(chip.promptKey).toMatch(/^home\.suggestion\..+\.prompt$/)
    }
  })
})
