/**
 * dialog-footer.test.ts
 *
 * Structural tests for the dialog footer slot (issue #440, slice 07).
 *
 * DOM rendering is impractical here: Dialog requires Kobalte portal context
 * and a DialogProvider. We verify the public interface and source structure
 * instead — matching the pattern used in icon-registry-rename.test.ts and
 * message-part-rename.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import * as dialogMod from "../../src/components/dialog"

const ROOT = join(import.meta.dirname, "../..")
const DIALOG_SRC = readFileSync(join(ROOT, "src/components/dialog.tsx"), "utf-8")

describe("Dialog footer slot (issue #440)", () => {
  test("Dialog component is exported", () => {
    expect(typeof dialogMod.Dialog).toBe("function")
  })

  test("dialog.tsx contains footer prop in interface", () => {
    // Verifies the footer prop was added to DialogProps
    expect(DIALOG_SRC).toContain("footer?: JSXElement")
  })

  test("dialog.tsx renders footer with data-slot='dialog-footer' attribute", () => {
    // Verifies the slot attribute matches the CSS and is not misspelled
    expect(DIALOG_SRC).toContain('data-slot="dialog-footer"')
  })

  test("dialog.tsx wraps footer in Show component (conditional render)", () => {
    // Footer must not render when the prop is omitted
    expect(DIALOG_SRC).toContain("<Show when={props.footer}>")
  })

  test("dialog.tsx passes props.footer as footer slot content", () => {
    expect(DIALOG_SRC).toContain("{props.footer}")
  })
})
