import { describe, expect, test } from "bun:test"
import {
  HOME_SUGGESTION_CHIPS,
  resolveVisibleHomeSuggestions,
  type HomeSuggestionChipID,
} from "./home-suggestions-state"

describe("resolveVisibleHomeSuggestions", () => {
  const allIDs = HOME_SUGGESTION_CHIPS.map((chip) => chip.id)

  test("returns all chips when first-time + enabled + nothing dismissed", () => {
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: true, enabled: true, dismissed: [] })).toEqual(allIDs)
  })

  test("returns empty when not a first-time visitor", () => {
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: false, enabled: true, dismissed: [] })).toEqual([])
  })

  test("returns empty when feature is disabled", () => {
    expect(resolveVisibleHomeSuggestions({ firstTimeVisitor: true, enabled: false, dismissed: [] })).toEqual([])
  })

  test("filters dismissed chips while preserving original order", () => {
    const dismissed: HomeSuggestionChipID[] = ["news-brief"]
    expect(
      resolveVisibleHomeSuggestions({ firstTimeVisitor: true, enabled: true, dismissed }),
    ).toEqual(allIDs.filter((id) => id !== "news-brief"))
  })

  test("returns empty when all three chips are dismissed", () => {
    expect(
      resolveVisibleHomeSuggestions({ firstTimeVisitor: true, enabled: true, dismissed: allIDs }),
    ).toEqual([])
  })

  test("HOME_SUGGESTION_CHIPS has stable IDs and three entries", () => {
    expect(HOME_SUGGESTION_CHIPS).toHaveLength(3)
    expect(allIDs).toEqual(["analyze-spreadsheet", "news-brief", "draft-email"])
  })

  test("each chip exposes a stable i18n key", () => {
    for (const chip of HOME_SUGGESTION_CHIPS) {
      expect(chip.i18nKey).toMatch(/^home\.suggestion\./)
    }
  })
})
