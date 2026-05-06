/**
 * sheet.test.ts
 *
 * Structural tests for the Sheet component (issue #440, slice 07).
 *
 * DOM rendering is impractical here: Sheet requires Kobalte dialog context.
 * We verify the public interface and source structure instead — matching the
 * pattern used in dialog-footer.test.ts, icon-registry-rename.test.ts, and
 * message-part-rename.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import * as sheetMod from "../src/components/sheet"

const ROOT = join(import.meta.dirname, "..")
const SHEET_SRC = readFileSync(join(ROOT, "src/components/sheet.tsx"), "utf-8")
const DIALOG_CSS = readFileSync(join(ROOT, "src/components/dialog.css"), "utf-8")

describe("Sheet component (issue #440)", () => {
  test("Sheet component is exported", () => {
    expect(typeof sheetMod.Sheet).toBe("function")
  })

  test("SheetSide type covers all four directions", () => {
    // Verifies the type union is present in source
    expect(SHEET_SRC).toContain('"right" | "left" | "top" | "bottom"')
  })

  test("SheetProps has open prop", () => {
    expect(SHEET_SRC).toContain("open: boolean")
  })

  test("SheetProps has onOpenChange prop", () => {
    expect(SHEET_SRC).toContain("onOpenChange: (open: boolean) => void")
  })

  test("SheetProps has side prop", () => {
    expect(SHEET_SRC).toContain("side?: SheetSide")
  })

  test("SheetProps has title prop", () => {
    expect(SHEET_SRC).toContain("title?: JSXElement")
  })

  test("SheetProps has footer prop", () => {
    expect(SHEET_SRC).toContain("footer?: JSXElement")
  })

  test("default side is right", () => {
    // The fallback expression in the component signals the documented default
    expect(SHEET_SRC).toContain('props.side ?? "right"')
  })

  test("sheet-content slot is used", () => {
    expect(SHEET_SRC).toContain('data-slot="sheet-content"')
  })

  test("sheet-body slot is used", () => {
    expect(SHEET_SRC).toContain('data-slot="sheet-body"')
  })

  test("footer renders conditionally via Show", () => {
    expect(SHEET_SRC).toContain("<Show when={props.footer}>")
  })

  test("footer slot attribute matches CSS", () => {
    expect(SHEET_SRC).toContain('data-slot="sheet-footer"')
  })

  test("title renders conditionally via Show", () => {
    expect(SHEET_SRC).toContain("<Show when={props.title}>")
  })

  test("sheet-header slot is used when title present", () => {
    expect(SHEET_SRC).toContain('data-slot="sheet-header"')
  })

  test("close button is included in header", () => {
    expect(SHEET_SRC).toContain('data-slot="sheet-close-button"')
  })

  test("Kobalte Root wraps with modal open onOpenChange", () => {
    // Root must exist with controlled props for open/close state, focus-trap, Escape key
    expect(SHEET_SRC).toContain("open={props.open}")
    expect(SHEET_SRC).toContain("onOpenChange={props.onOpenChange}")
  })

  test("Kobalte.Portal is used for proper stacking", () => {
    expect(SHEET_SRC).toContain("Kobalte.Portal")
  })

  test("dialog-overlay is used for scrim (inlined per DESIGN.md)", () => {
    // Reuses shared dialog-overlay which inlines the spec scrim color.
    expect(SHEET_SRC).toContain('data-component="dialog-overlay"')
    expect(DIALOG_CSS).toContain("rgba(26, 22, 19, 0.32)")
  })

  test("CloseButton uses IconButton with aria-label", () => {
    expect(SHEET_SRC).toContain("as={IconButton}")
    expect(SHEET_SRC).toContain('aria-label={i18n.t("ui.common.close")}')
  })
})
