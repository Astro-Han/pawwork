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

  test("computes firstTimeVisitor from sync.data.session.length and sync.ready", () => {
    expect(source).toContain("sync.data.session")
    expect(source).toMatch(/sync\.data\.session\??\.length/)
    expect(source).toContain("sync.ready")
  })

  test("exposes the documented data-component and data-action hooks for E2E", () => {
    expect(source).toContain('data-component="home-suggestion-list"')
    expect(source).toContain('data-action="home-suggestion-row"')
    expect(source).toContain('data-action="home-suggestion-row-dismiss"')
  })

  test("does NOT render a section-level dismiss (only per-row X remains)", () => {
    expect(source).not.toContain("home-suggestion-section-dismiss")
    expect(source).not.toContain("home.suggestion.section")
  })

  test("does NOT couple to homeSuggestionsEnabled or homeSuggestionsSeen (those were removed)", () => {
    expect(source).not.toContain("homeSuggestionsEnabled")
    expect(source).not.toContain("homeSuggestionsSeen")
    expect(source).not.toContain("setHomeSuggestionsSeen")
  })

  test("prefills the composer via prompt.set and focuses the editor", () => {
    expect(source).toContain("prompt.set([")
    expect(source).toContain('[data-component="prompt-input"]')
  })

  test("explicitly restores caret position after focus so follow-up typing works deterministically", () => {
    expect(source).toContain("setCursorPosition")
  })

  test("respects user-typed content via prompt.dirty() (does not overwrite)", () => {
    expect(source).toContain("prompt.dirty()")
    const dirtyBranch = source.match(/if \(prompt\.dirty\(\)\)\s*\{[\s\S]*?\}/)
    expect(dirtyBranch).not.toBeNull()
    expect(dirtyBranch![0]).not.toContain("prompt.set(")
  })

  test("filters dismissed IDs against known chip IDs (no bare type cast)", () => {
    expect(source).toContain("filterKnownIDs")
    expect(source).not.toMatch(/homeSuggestionsDismissed\(\) as HomeSuggestionChipID\[\]/)
  })

  test("uses the settings accessor for read and write (not raw store)", () => {
    expect(source).toContain("settings.general.homeSuggestionsDismissed()")
    expect(source).toContain("settings.general.setHomeSuggestionsDismissed(")
    expect(source).not.toContain("settings.store.general")
    expect(source).not.toContain("settings.setStore(")
  })

  test("rest-state dismiss button is not clickable (pointer-events-none) and not in tab order", () => {
    expect(source).toContain("pointer-events-none")
    expect(source).toContain("group-hover:pointer-events-auto")
    expect(source).toContain("tabIndex={-1}")
  })

  test("renders nothing when there are no visible chips", () => {
    expect(source).toContain("visibleChips().length > 0")
  })

  test("uses i18n keys for chip text and aria-label", () => {
    expect(source).toContain("home.suggestion.row.dismiss")
  })
})
