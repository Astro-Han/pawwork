/**
 * CommandPalette primitive — structural contract.
 * Slice 07, issue #440.
 *
 * Source-string assertions only (DOM render needs Kobalte dialog context;
 * see sheet.test.ts for the same convention). Runtime behaviour is covered
 * by packages/app/e2e/app/palette.spec.ts and palette-viewport.spec.ts.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import * as paletteMod from "../src/components/command-palette"

const ROOT = join(import.meta.dirname, "..")
const SRC = readFileSync(join(ROOT, "src/components/command-palette.tsx"), "utf-8")

describe("CommandPalette — exports", () => {
  test("CommandPalette component is exported", () => {
    expect(typeof paletteMod.CommandPalette).toBe("function")
  })
})

describe("CommandPalette — a11y", () => {
  test("Kobalte.Content forwards aria-label from props.label", () => {
    expect(SRC).toMatch(/aria-label=\{props\.label\}/)
  })
})

describe("CommandPalette — autofocus parity with Dialog", () => {
  // dialog.tsx attaches an explicit onOpenAutoFocus that finds [autofocus]
  // and focuses it (overrides Kobalte's default first-focusable behaviour).
  // The palette migration must keep the same contract — dialog-select-file
  // (and other consumers) rely on `<List search={{ autofocus: true }}>` to
  // get the textbox focused on open.
  test("attaches onOpenAutoFocus on Kobalte.Content", () => {
    expect(SRC).toMatch(/onOpenAutoFocus=/)
  })

  test("handler queries for [autofocus] and focuses it", () => {
    expect(SRC).toMatch(/querySelector\("\[autofocus\]"\)/)
    expect(SRC).toMatch(/autofocusEl\.focus\(\)/)
  })

  test("handler calls preventDefault before focusing (overrides Kobalte default)", () => {
    expect(SRC).toMatch(/e\.preventDefault\(\)[\s\S]*autofocusEl\.focus\(\)/)
  })
})
