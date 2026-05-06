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
const pickerCss = readFileSync(new URL("./picker.css", import.meta.url), "utf8")
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
    // Kobalte sets data-selected on selected items. The picker contract layer
    // (picker.css) handles selected styling for any data-picker-item, which
    // Select opts into.
    expect(pickerCss).toContain("[data-picker-item]")
    expect(pickerCss).toContain("[data-selected]")
    expect(pickerCss).toContain("--row-active-overlay")
    expect(selectSrc).toContain('data-picker-item=""')
  })

  test("selected: item indicator slot is present in item component", () => {
    expect(selectSrc).toContain('data-slot="select-select-item-indicator"')
  })

  test("default triggerVariant: prop type now includes explicit 'default'", () => {
    // triggerVariant is optional — when set to "default" (or undefined) the
    // trigger uses the picker.css contract (h28, radius-md, row-hover-overlay).
    expect(selectSrc).toMatch(/triggerVariant\?\s*:\s*"default"\s*\|\s*"settings"/)
  })

  test("settings triggerVariant: adds data-trigger-style='settings' on trigger", () => {
    // data-trigger-style is spread from triggerVariant value directly.
    expect(selectSrc).toContain("data-trigger-style={local.triggerVariant}")
    expect(selectCss).toContain('[data-trigger-style="settings"]')
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
    // Whitespace-tolerant so a future formatter pass can't break the contract.
    expect(textFieldSrc).toMatch(/local\.error\s*\?\s*"invalid"/)
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

  test("error/invalid: CSS has a [data-invalid] selector for visual state", () => {
    expect(textFieldCss).toMatch(/\[data-invalid\]/)
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
    expect(splitMatch).not.toBeNull()
    const splitList = splitMatch![1]
    expect(splitList).not.toContain('"checked"')
  })

  test("checked: CSS has a data-checked selector for visual state", () => {
    expect(switchCss).toMatch(/\[data-checked\]/)
  })
})

// Checkbox was deleted in slice 05 — removed from state matrix
