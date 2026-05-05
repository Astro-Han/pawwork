/**
 * inputs-state-matrix.test.tsx
 *
 * State-matrix contract test for slices #04-#07 input components.
 *
 * Tests DOM attributes and source structure that represent component states.
 * Since bun:test does not provide a real browser DOM (no Kobalte rendering),
 * we verify states through static source analysis and structural assertions.
 *
 * VISUAL STATES NOT COVERED HERE (verified via dev:desktop screenshots in PR):
 *   - hover: CSS :hover pseudo-class, requires pointer interaction
 *   - focus-visible: CSS :focus-visible, requires keyboard navigation
 *   - active/pressed: CSS :active, requires pointer down event
 *
 * STATE MATRIX:
 * | Component  | default | disabled | error/invalid | checked | selected |
 * |------------|---------|----------|---------------|---------|----------|
 * | Select     |   yes   |   yes    |      n/a      |   n/a   |   yes    |
 * | TextField  |   yes   |   yes    |      yes      |   n/a   |   n/a    |
 * | Switch     |   yes   |   yes    |      n/a      |   yes   |   n/a    |
 * (Checkbox deleted in slice 05 — no longer in state matrix)
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const selectSrc = readFileSync(new URL("./select.tsx", import.meta.url), "utf8")
const selectCss = readFileSync(new URL("./select.css", import.meta.url), "utf8")
const switchSrc = readFileSync(new URL("./switch.tsx", import.meta.url), "utf8")
const switchCss = readFileSync(new URL("./switch.css", import.meta.url), "utf8")
const textFieldSrc = readFileSync(new URL("./text-field.tsx", import.meta.url), "utf8")
const textFieldCss = readFileSync(new URL("./text-field.css", import.meta.url), "utf8")

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------
describe("state-matrix: Select", () => {
  test("default: root has data-component='select'", () => {
    expect(selectSrc).toContain('data-component="select"')
  })

  test("default: trigger has data-slot='select-select-trigger'", () => {
    expect(selectSrc).toContain('data-slot="select-select-trigger"')
  })

  test("disabled: trigger forwards disabled prop to Kobalte.Trigger", () => {
    // The trigger must pass disabled from props so Kobalte sets aria-disabled.
    expect(selectSrc).toContain("disabled={props.disabled}")
  })

  test("selected: item renders ItemIndicator slot (aria-selected managed by Kobalte)", () => {
    // Kobalte sets data-selected on selected items. The CSS must handle it.
    expect(selectCss).toContain("[data-selected]")
    expect(selectCss).toContain("--surface-interactive-base")
  })

  test("selected: item indicator slot is present in item component", () => {
    expect(selectSrc).toContain('data-slot="select-select-item-indicator"')
  })

  test("default triggerVariant: prop type allows undefined (no variant set)", () => {
    // triggerVariant is optional — undefined means default style.
    expect(selectSrc).toMatch(/triggerVariant\?\s*:\s*"settings"\s*\|\s*"review-filter"/)
  })

  test("settings triggerVariant: adds data-trigger-style='settings' on trigger", () => {
    // data-trigger-style is spread from triggerVariant value directly.
    expect(selectSrc).toContain("data-trigger-style={local.triggerVariant}")
    expect(selectCss).toContain('[data-trigger-style="settings"]')
  })

  test("review-filter triggerVariant: CSS block defines height 24px", () => {
    expect(selectCss).toContain('[data-trigger-style="review-filter"]')
    const rfIdx = selectCss.indexOf('[data-trigger-style="review-filter"]')
    const rfBlock = selectCss.slice(rfIdx, rfIdx + 300)
    expect(rfBlock).toContain("height: 24px")
  })
})

// ---------------------------------------------------------------------------
// TextField (maps to <input> / <textarea> with Kobalte TextField)
// ---------------------------------------------------------------------------
describe("state-matrix: TextField", () => {
  test("default: root renders with data-component='input'", () => {
    expect(textFieldSrc).toContain('data-component="input"')
  })

  test("default: input has data-slot='input-input'", () => {
    expect(textFieldSrc).toContain('data-slot="input-input"')
  })

  test("disabled: disabled prop is forwarded to Kobalte root", () => {
    // Kobalte applies aria-disabled and data-disabled when disabled is set.
    expect(textFieldSrc).toContain("disabled={local.disabled}")
  })

  test("error/invalid: error prop sets validationState to 'invalid'", () => {
    expect(textFieldSrc).toContain('"invalid"')
    // The derived accessor must check the error string.
    expect(textFieldSrc).toContain("local.error ? \"invalid\"")
  })

  test("error/invalid: error prop renders alert-triangle icon in error message", () => {
    expect(textFieldSrc).toContain('name="alert-triangle"')
  })

  test("error/invalid: error prop renders error message slot", () => {
    expect(textFieldSrc).toContain('data-slot="input-error"')
  })

  test("error/invalid: validationState is passed to Kobalte root", () => {
    expect(textFieldSrc).toContain("validationState={validationState()}")
  })
})

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------
describe("state-matrix: Switch", () => {
  test("default: root has data-component='switch'", () => {
    expect(switchSrc).toContain('data-component="switch"')
  })

  test("default: control and thumb slots are present", () => {
    expect(switchSrc).toContain('data-slot="switch-control"')
    expect(switchSrc).toContain('data-slot="switch-thumb"')
  })

  test("default: input slot is present for accessibility", () => {
    // Kobalte.Input renders the actual <input type='checkbox'> with aria-checked.
    expect(switchSrc).toContain('data-slot="switch-input"')
  })

  test("disabled: Switch accepts disabled from Kobalte ComponentProps spread", () => {
    // Switch spreads {...others} to Kobalte root, which includes disabled.
    // Verify others is spread (not filtered out).
    expect(switchSrc).toContain("{...others}")
    // disabled must NOT be in the local splitProps list (so it passes through).
    const splitMatch = switchSrc.match(/splitProps\(props,\s*\[([^\]]+)\]/)
    expect(splitMatch).not.toBeNull()
    const splitList = splitMatch![1]
    expect(splitList).not.toContain('"disabled"')
  })

  test("checked: Kobalte manages aria-checked via checked/defaultChecked prop", () => {
    // checked prop flows through {...others} to Kobalte root.
    // Kobalte.Input renders <input type='checkbox' aria-checked='...'>.
    expect(switchSrc).toContain("{...others}")
    // checked is not in splitProps local list (so it flows through).
    const splitMatch = switchSrc.match(/splitProps\(props,\s*\[([^\]]+)\]/)
    const splitList = splitMatch![1]
    expect(splitList).not.toContain('"checked"')
  })

  test("checked: CSS has a data-checked selector for visual state", () => {
    expect(switchCss).toMatch(/\[data-checked\]/)
  })
})

// Checkbox was deleted in slice 05 — removed from state matrix
