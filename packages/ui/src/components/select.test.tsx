/**
 * select.test.tsx
 *
 * Static source-analysis tests for the Select component.
 *
 * Trigger / content / item base styles (height, hover, selected, surface) are
 * defined in picker.css and verified by picker.test.ts. This file focuses on
 * Select-specific concerns: data-component / data-slot wiring, picker contract
 * opt-in (data-picker-* slot attributes), the triggerVariant type & data
 * mapping, and the settings chrome that lives outside the contract.
 *
 * Visual states (hover, focus-visible, active) are verified via dev:desktop
 * screenshots in the PR description.
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

describe("Select: picker contract opt-in", () => {
  // The Select primitive opts into the shared picker.css contract by spreading
  // data-picker-trigger / data-picker-content / data-picker-item attributes.
  // The contract owns height / radius / hover / selected; Select keeps only
  // its variant chrome (chevron, settings/review-filter triggers).

  test("trigger spreads data-picker-trigger", () => {
    expect(src).toContain('data-picker-trigger=""')
  })

  test("content spreads data-picker-content", () => {
    expect(src).toContain('data-picker-content=""')
  })

  test("item spreads data-picker-item", () => {
    expect(src).toContain('data-picker-item=""')
  })

  test("select.css does NOT redefine [data-picker-item] hover/selected", () => {
    // Anything Select duplicating from picker.css would defeat the contract —
    // and silently win because of higher specificity.
    expect(css).not.toContain("--row-hover-overlay")
    expect(css).not.toContain("--row-active-overlay")
  })
})

describe("Select: triggerVariant prop type", () => {
  test('triggerVariant type annotation includes "default"', () => {
    expect(src).toContain('"default"')
  })

  test('triggerVariant type annotation includes "settings"', () => {
    expect(src).toContain('"settings"')
  })
})

describe("Select: triggerVariant maps to data-trigger-style", () => {
  test("data-trigger-style is set from triggerVariant prop", () => {
    expect(src).toContain("data-trigger-style={local.triggerVariant}")
  })

  test('settings variant: data-trigger-style="settings" CSS block exists', () => {
    expect(css).toContain('[data-trigger-style="settings"]')
  })
})

describe("Select: settings variant CSS", () => {
  test("settings variant keeps the flex-end value alignment", () => {
    const settingsIdx = css.indexOf('&[data-trigger-style="settings"]')
    expect(settingsIdx).toBeGreaterThan(-1)
    const block = css.slice(settingsIdx, settingsIdx + 800)
    expect(block).toContain("justify-content: flex-end")
  })

  test("settings variant value is rendered at the body role size", () => {
    const settingsIdx = css.indexOf('&[data-trigger-style="settings"]')
    const block = css.slice(settingsIdx, settingsIdx + 800)
    expect(block).toContain("--font-size-body")
  })

  test("settings variant does NOT override hover with --surface-sunken", () => {
    // The settings trigger used to hover with cream (--surface-sunken).
    // The picker contract now owns hover (--row-hover-overlay), so settings
    // must not redefine it.
    const settingsIdx = css.indexOf('&[data-trigger-style="settings"]')
    const block = css.slice(settingsIdx, settingsIdx + 1200)
    expect(block).not.toContain("--surface-sunken")
  })
})
