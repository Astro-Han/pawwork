/**
 * Dialog primitive — class/classList forwarding contract.
 * Slice 07, issue #440.
 *
 * The previous implementation merged props.class into a classList object as
 * a key: `classList={{ [props.class ?? ""]: !!props.class }}`. SolidJS's
 * classList runtime trims+splits multi-token keys before delegating to
 * DOM classList.toggle, so that form did not actually crash, but the
 * inline form is the codebase convention (Sheet migrated first; Dialog
 * followed). This test pins both primitives at the inline form so a
 * future refactor cannot silently regress to the legacy classList-key
 * pattern.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const DIALOG_TSX = readFileSync(join(ROOT, "src/components/dialog.tsx"), "utf-8")
const SHEET_TSX = readFileSync(join(ROOT, "src/components/sheet.tsx"), "utf-8")

describe("Dialog — class/classList forwarding", () => {
  test("forwards props.class via class={...}, not as classList key", () => {
    expect(DIALOG_TSX).toMatch(/class=\{props\.class\}/)
    expect(DIALOG_TSX).toMatch(/classList=\{props\.classList\}/)
  })

  test("does not merge props.class into classList object as key (regression guard)", () => {
    expect(DIALOG_TSX).not.toMatch(/\[props\.class\s*\?\?\s*""\]\s*:\s*!!props\.class/)
  })
})

describe("Sheet — class/classList forwarding (same pattern as Dialog)", () => {
  test("forwards props.class via class={...}", () => {
    expect(SHEET_TSX).toMatch(/class=\{props\.class\}/)
    expect(SHEET_TSX).toMatch(/classList=\{props\.classList\}/)
  })

  test("does not merge props.class into classList object as key", () => {
    expect(SHEET_TSX).not.toMatch(/\[props\.class\s*\?\?\s*""\]\s*:\s*!!props\.class/)
  })
})
