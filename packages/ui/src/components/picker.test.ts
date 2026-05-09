/**
 * picker.test.ts
 *
 * Source-text checks for picker.css contract layer.
 *
 * Three primitives (Select / List / hand-written Popover) opt into one shared
 * visual contract by spreading data-picker-trigger / data-picker-content /
 * data-picker-item slot attributes. This file pins the contract source so
 * regressions in any primitive's CSS don't accidentally re-implement (and
 * drift from) the contract.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const css = readFileSync(new URL("./picker.css", import.meta.url), "utf8")

describe("picker.css: contract selectors are present", () => {
  test("[data-picker-trigger] selector exists", () => {
    expect(css).toContain("[data-picker-trigger]")
  })

  test("[data-picker-content] selector exists", () => {
    expect(css).toContain("[data-picker-content]")
  })

  test("[data-picker-item] selector exists", () => {
    expect(css).toContain("[data-picker-item]")
  })
})

describe("picker.css: trigger contract", () => {
  test("trigger height is 30px", () => {
    const triggerIdx = css.indexOf("[data-picker-trigger] {")
    expect(triggerIdx).toBeGreaterThan(-1)
    const block = css.slice(triggerIdx, triggerIdx + 300)
    expect(block).toContain("height: 30px")
  })

  test("trigger border-radius uses --radius-md", () => {
    const triggerIdx = css.indexOf("[data-picker-trigger] {")
    const block = css.slice(triggerIdx, triggerIdx + 300)
    expect(block).toContain("--radius-md")
  })

  test("trigger hover uses --row-hover-overlay", () => {
    expect(css).toMatch(/\[data-picker-trigger\][\s\S]*?:hover[\s\S]*?--row-hover-overlay/)
  })

  test("trigger expanded uses --row-hover-overlay (parity with hover)", () => {
    expect(css).toMatch(/\[data-picker-trigger\][\s\S]*?data-expanded[\s\S]*?--row-hover-overlay/)
  })
})

describe("picker.css: content contract", () => {
  test("content uses --surface-base background", () => {
    const contentIdx = css.indexOf("[data-picker-content] {")
    expect(contentIdx).toBeGreaterThan(-1)
    const block = css.slice(contentIdx, contentIdx + 300)
    expect(block).toContain("--surface-base")
  })

  test("content uses --radius-md", () => {
    const contentIdx = css.indexOf("[data-picker-content] {")
    const block = css.slice(contentIdx, contentIdx + 300)
    expect(block).toContain("--radius-md")
  })

  test("content padding is 4px", () => {
    const contentIdx = css.indexOf("[data-picker-content] {")
    const block = css.slice(contentIdx, contentIdx + 300)
    expect(block).toContain("padding: 4px")
  })

  test("content has shadow-floating", () => {
    const contentIdx = css.indexOf("[data-picker-content] {")
    const block = css.slice(contentIdx, contentIdx + 300)
    expect(block).toContain("--shadow-floating")
  })
})

describe("picker.css: item contract", () => {
  test("item height is 30px", () => {
    const itemIdx = css.indexOf("[data-picker-item] {")
    expect(itemIdx).toBeGreaterThan(-1)
    const block = css.slice(itemIdx, itemIdx + 800)
    expect(block).toContain("height: 30px")
  })

  test("item padding is 0 8px", () => {
    const itemIdx = css.indexOf("[data-picker-item] {")
    const block = css.slice(itemIdx, itemIdx + 800)
    expect(block).toContain("padding: 0 8px")
  })

  test("item border-radius uses --radius-sm", () => {
    const itemIdx = css.indexOf("[data-picker-item] {")
    const block = css.slice(itemIdx, itemIdx + 800)
    expect(block).toContain("--radius-sm")
  })

  test("item font-size uses --font-size-small (13px)", () => {
    const itemIdx = css.indexOf("[data-picker-item] {")
    const block = css.slice(itemIdx, itemIdx + 800)
    expect(block).toContain("--font-size-small")
  })

  test("item font-weight uses --font-weight-regular by default", () => {
    const itemIdx = css.indexOf("[data-picker-item] {")
    const block = css.slice(itemIdx, itemIdx + 800)
    expect(block).toContain("--font-weight-regular")
  })

  test("item hover uses --row-hover-overlay", () => {
    // Hover/highlighted/active in :where() not paired with [data-selected]
    expect(css).toMatch(
      /\[data-picker-item\]:where\(:hover, \[data-highlighted\], \[data-active="true"\]\)[\s\S]*?--row-hover-overlay/,
    )
  })

  test("item selected uses --row-active-overlay + medium weight", () => {
    expect(css).toMatch(
      /\[data-picker-item\]:where\(\[data-selected\]\)[\s\S]*?--row-active-overlay[\s\S]*?--font-weight-medium/,
    )
  })

  test("hover-on-selected stays selected (no double overlay)", () => {
    expect(css).toMatch(
      /\[data-picker-item\]:where\([\s\S]*?\[data-selected\]:hover[\s\S]*?\)[\s\S]*?--row-active-overlay/,
    )
  })

  test("disabled item is non-interactive and dimmed", () => {
    const disabledIdx = css.indexOf("[data-disabled]")
    expect(disabledIdx).toBeGreaterThan(-1)
    const block = css.slice(disabledIdx, disabledIdx + 200)
    expect(block).toContain("pointer-events: none")
    expect(block).toContain("opacity")
  })
})

describe("picker.css: low-specificity contract", () => {
  test("most rules are wrapped in :where() so primitive CSS can override", () => {
    // The contract is the floor, not the ceiling — :where() keeps specificity
    // at (0,1,0), so any primitive selector with two attribute selectors wins.
    const whereCount = (css.match(/:where\(/g) ?? []).length
    expect(whereCount).toBeGreaterThanOrEqual(4)
  })
})

describe("picker.css: imported into the styles index", () => {
  test("styles/index.css imports picker.css in the components layer", () => {
    const indexCss = readFileSync(new URL("../styles/index.css", import.meta.url), "utf8")
    expect(indexCss).toMatch(/@import "\.\.\/components\/picker\.css" layer\(components\);/)
  })
})
