import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("HomeSuggestionList source contract", () => {
  const source = readFileSync("src/components/home/home-suggestion-list.tsx", "utf8")

  test("wires the helper, prompt, settings, sync, and language contexts", () => {
    expect(source).toContain("resolveVisibleHomeSuggestions")
    expect(source).toContain("usePrompt")
    expect(source).toContain("useSettings")
    expect(source).toContain("useSync")
    expect(source).toContain("useLanguage")
  })

  test("computes firstTimeVisitor from sync.data.session count", () => {
    expect(source).toContain("sync.data.session")
    expect(source).toMatch(/Object\.keys\([^)]*session[^)]*\)\.length/)
  })

  test("guards firstTimeVisitor on sync.ready to avoid flashing during hydration", () => {
    expect(source).toContain("sync.ready")
  })

  test("uses homeSuggestionsSeen as a one-way bit so returning users do not re-enter onboarding", () => {
    // firstTimeVisitor must factor in seen flag
    expect(source).toContain("homeSuggestionsSeen")
    expect(source).toContain("setHomeSuggestionsSeen(true)")
    // session-count > 0 should flip seen=true via createEffect (one-way hydration latch)
    expect(source).toMatch(/createEffect\([\s\S]{0,400}setHomeSuggestionsSeen\(true\)/)
  })

  test("exposes the documented data-component and data-action hooks for E2E", () => {
    expect(source).toContain('data-component="home-suggestion-list"')
    expect(source).toContain('data-action="home-suggestion-row"')
    expect(source).toContain('data-action="home-suggestion-row-dismiss"')
    expect(source).toContain('data-action="home-suggestion-section-dismiss"')
  })

  test("prefills the composer via prompt.set and focuses the editor", () => {
    expect(source).toContain("prompt.set([")
    expect(source).toContain('[data-component="prompt-input"]')
  })

  test("explicitly restores caret position after focus so follow-up typing works deterministically", () => {
    expect(source).toContain("setCursorPosition")
  })

  test("respects user-typed content via prompt.dirty() before overwriting", () => {
    expect(source).toContain("prompt.dirty()")
  })

  test("filters dismissed IDs against known chip IDs (no bare type cast)", () => {
    expect(source).toContain("filterKnownIDs")
    // negative: must NOT launder the persisted store value with a bare cast
    expect(source).not.toMatch(/homeSuggestionsDismissed\(\) as HomeSuggestionChipID\[\]/)
  })

  test("uses the settings accessor for read and write (not raw store)", () => {
    expect(source).toContain("settings.general.homeSuggestionsEnabled()")
    expect(source).toContain("settings.general.homeSuggestionsDismissed()")
    expect(source).toContain("settings.general.setHomeSuggestionsDismissed(")
    expect(source).not.toContain("settings.store.general")
    expect(source).not.toContain("settings.setStore(")
  })

  test("section dismiss writes all three chip ids", () => {
    expect(source).toContain("HOME_SUGGESTION_CHIPS.map")
  })

  test("rest-state dismiss button is not clickable (pointer-events-none) and not in tab order", () => {
    expect(source).toContain("pointer-events-none")
    expect(source).toContain("group-hover:pointer-events-auto")
    expect(source).toContain("tabIndex={-1}")
  })

  test("renders nothing when there are no visible chips", () => {
    expect(source).toContain("visibleChips().length > 0")
  })

  test("uses i18n keys for chip text and aria-labels", () => {
    expect(source).toContain("home.suggestion.section.label")
    expect(source).toContain("home.suggestion.section.dismiss")
    expect(source).toContain("home.suggestion.row.dismiss")
  })
})
