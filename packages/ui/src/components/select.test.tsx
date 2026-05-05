/**
 * select.test.tsx
 *
 * Static source-analysis tests for Select component.
 * Since Kobalte requires a real browser DOM environment that bun:test
 * does not provide (no happy-dom registrator available here), we verify
 * props, DOM slots, and CSS tokens by inspecting source text.
 *
 * Visual states (hover, focus-visible, active) are verified via
 * dev:desktop screenshots in the PR description.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const src = readFileSync(new URL("./select.tsx", import.meta.url), "utf8")
const css = readFileSync(new URL("./select.css", import.meta.url), "utf8")

describe("Select: data-component attribute", () => {
  test('root element renders with data-component="select"', () => {
    expect(src).toContain('data-component="select"')
  })
})

describe("Select: DOM slot presence", () => {
  test('trigger button has data-slot="select-select-trigger"', () => {
    expect(src).toContain('data-slot="select-select-trigger"')
  })

  test('value display has data-slot="select-select-trigger-value"', () => {
    expect(src).toContain('data-slot="select-select-trigger-value"')
  })

  test('popover container has data-component="select-content"', () => {
    expect(src).toContain('data-component="select-content"')
  })

  test('each item has data-slot="select-select-item"', () => {
    expect(src).toContain('data-slot="select-select-item"')
  })
})

describe("Select: triggerVariant prop type includes review-filter", () => {
  test('triggerVariant type annotation includes "review-filter"', () => {
    // The prop type must include the new variant value.
    expect(src).toContain('"review-filter"')
  })

  test('triggerVariant type annotation still includes "settings"', () => {
    expect(src).toContain('"settings"')
  })
})

describe("Select: triggerVariant maps to data-trigger-style", () => {
  test("data-trigger-style is set from triggerVariant prop", () => {
    // The trigger element and/or root must spread triggerVariant as data-trigger-style.
    expect(src).toContain("data-trigger-style={local.triggerVariant}")
  })

  test('settings variant: data-trigger-style="settings" CSS block exists', () => {
    expect(css).toContain('[data-trigger-style="settings"]')
  })

  test('review-filter variant: data-trigger-style="review-filter" CSS block exists', () => {
    // This verifies the new variant is implemented in CSS.
    expect(css).toContain('[data-trigger-style="review-filter"]')
  })
})

describe("Select: CSS token corrections", () => {
  test("popover container uses --surface-base (not --surface-raised) for background", () => {
    // The [data-component="select-content"] block must reference surface-base.
    // We extract the block by looking for content after the selector.
    const contentIdx = css.indexOf('[data-component="select-content"]')
    expect(contentIdx).toBeGreaterThan(-1)
    const contentBlock = css.slice(contentIdx, contentIdx + 400)
    expect(contentBlock).toContain("--surface-base")
    // Must NOT use surface-raised as the direct background for the container.
    // (surface-raised may still appear in nested/scoped rules for the trigger icon)
    const bgLine = contentBlock.match(/background-color:\s*var\(--surface-raised\)/)
    expect(bgLine).toBeNull()
  })

  test("item hover uses --bg-cream (not --surface-raised)", () => {
    expect(css).toContain("--bg-cream")
    // Old incorrect hover token must not appear in highlighted/hover rules.
    const highlightedIdx = css.indexOf("[data-highlighted]")
    expect(highlightedIdx).toBeGreaterThan(-1)
    const highlightedRule = css.slice(highlightedIdx, highlightedIdx + 80)
    expect(highlightedRule).toContain("--bg-cream")
    expect(highlightedRule).not.toContain("--surface-raised")
  })

  test("item selected state uses --surface-interactive-base (STANDARDS L30: body weight, not medium)", () => {
    expect(css).toContain("--surface-interactive-base")
    expect(css).toContain("[data-selected]")
    const selectedIdx = css.indexOf("[data-selected]")
    const selectedBlock = css.slice(selectedIdx, selectedIdx + 200)
    expect(selectedBlock).toContain("--surface-interactive-base")
  })

  test("item border-radius uses --radius-sm", () => {
    // Items must use var(--radius-sm) not a raw px literal for border-radius.
    const itemIdx = css.indexOf('[data-slot="select-select-item"]')
    expect(itemIdx).toBeGreaterThan(-1)
    const itemBlock = css.slice(itemIdx, itemIdx + 400)
    expect(itemBlock).toContain("--radius-sm")
  })

  test("item height is 32px", () => {
    const itemIdx = css.indexOf('[data-slot="select-select-item"]')
    const itemBlock = css.slice(itemIdx, itemIdx + 400)
    expect(itemBlock).toContain("height: 32px")
  })

  test("no raw transition literals — uses --duration-base", () => {
    // Any transition durations must use var(--duration-base), not raw 0.15s/0.2s literals.
    const transitionLiterals = css.match(/transition:[^;]*(?:0\.15s|0\.2s|150ms|200ms)/g)
    expect(
      transitionLiterals,
      `Found raw transition duration literals; use var(--duration-base) instead: ${transitionLiterals?.join(", ")}`,
    ).toBeNull()
  })
})

describe("Select: review-filter variant CSS", () => {
  test("review-filter trigger has height: 24px", () => {
    const rfIdx = css.indexOf('[data-trigger-style="review-filter"]')
    expect(rfIdx).toBeGreaterThan(-1)
    const rfBlock = css.slice(rfIdx, rfIdx + 300)
    expect(rfBlock).toContain("height: 24px")
  })

  test("review-filter trigger has border-radius: var(--radius-sm)", () => {
    const rfIdx = css.indexOf('[data-trigger-style="review-filter"]')
    const rfBlock = css.slice(rfIdx, rfIdx + 300)
    expect(rfBlock).toContain("--radius-sm")
  })

  test("review-filter trigger has font-weight: var(--font-weight-regular)", () => {
    const rfIdx = css.indexOf('[data-trigger-style="review-filter"]')
    const rfBlock = css.slice(rfIdx, rfIdx + 300)
    expect(rfBlock).toContain("--font-weight-regular")
  })

  test("review-filter trigger has background: transparent", () => {
    const rfIdx = css.indexOf('[data-trigger-style="review-filter"]')
    const rfBlock = css.slice(rfIdx, rfIdx + 300)
    expect(rfBlock).toContain("transparent")
  })
})
