// Path B Space-trigger integration test.
//
// Regression guard for PR #785 review P1: setting `mirror.input = true` on
// Path B hit short-circuited reconcile because the raw `/brainstorming ` DOM
// looked "normalized" to isNormalizedEditor(). The store gained a marked
// TextPart, but the editor never repainted into pill DOM, so the user kept
// seeing raw slash text — #778 main acceptance path broken.
//
// This test pins the chain:
//   1. Raw DOM + insertText Space input  ──►  tryPathBConversion returns marked
//   2. Raw DOM is treated as normalized by isNormalizedEditor (would have
//      caused the old short-circuit)
//   3. Marked prompt vs parsed raw prompt are NOT equal, so the non-mirror
//      reconcile branch fires renderPartsToEditor
//   4. After repaint, DOM contains [data-cmd-mark] and visible label has no
//      leading slash

import { describe, expect, test } from "bun:test"
import { isPromptEqual, type CommandSource } from "@/context/prompt"
import { tryPathBConversion } from "./command-space-trigger"
import {
  isNormalizedEditor,
  parseEditorToParts,
  renderPartsToEditor,
} from "./editor-serialize"
import { setCursorPosition, getCursorPosition } from "./editor-dom"
import type { CommandDescriptor } from "./command-text-part"

const registry: CommandDescriptor[] = [
  { name: "brainstorming", source: "skill" as CommandSource, icon: "command" },
]

describe("Path B integration: Space-trigger repaints DOM to pill", () => {
  test("/brainstorming + Space → DOM gains [data-cmd-mark], raw slash gone", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    editor.appendChild(document.createTextNode("/brainstorming "))
    document.body.appendChild(editor)

    try {
      const rawParts = parseEditorToParts(editor)
      expect(rawParts.length).toBe(1)
      expect(rawParts[0]?.type).toBe("text")
      // Pre-conversion: no command metadata on the raw text part.
      expect((rawParts[0] as any).command).toBeUndefined()

      // (1) Path B conversion produces a marked Prompt.
      const pathB = tryPathBConversion({
        inputType: "insertText",
        data: " ",
        rawText: (rawParts[0] as any).content,
        images: [],
        registry,
      })
      expect(pathB).not.toBeNull()
      expect((pathB!.prompt[0] as any).command?.name).toBe("brainstorming")

      // (2) Raw DOM looks normalized. The OLD mirror.input=true short-circuit
      // would have stopped here, leaving the user looking at raw slash text.
      expect(isNormalizedEditor(editor)).toBe(true)

      // (3) Marked Prompt is NOT equal to the parsed raw Prompt. The
      // non-mirror reconcile branch detects this and forces a repaint.
      expect(isPromptEqual(pathB!.prompt, rawParts)).toBe(false)

      // (4) Repaint pushes pill DOM, raw "/brainstorming " text node is gone.
      renderPartsToEditor(editor, pathB!.prompt)
      setCursorPosition(editor, pathB!.cursor)

      const pill = editor.querySelector("[data-cmd-mark]") as HTMLElement | null
      expect(pill).not.toBeNull()
      expect(pill!.dataset.name).toBe("brainstorming")
      expect(pill!.getAttribute("contenteditable")).toBe("false")

      // Visible label has no leading slash.
      const label = pill!.querySelector("[data-cmd-label]") as HTMLElement
      expect(label.textContent).toBe("brainstorming")
      expect(label.textContent ?? "").not.toMatch(/^\//)

      // Editor no longer contains a raw "/brainstorming " text run as a sibling
      // of the pill (the slash now lives only in the marked TextPart content).
      const directTextChildren = Array.from(editor.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
      for (const t of directTextChildren) {
        expect(t).not.toMatch(/^\/brainstorming/)
      }

      // Caret target reported by Path B matches the marked content length;
      // after setCursorPosition the editor reports the same logical position.
      expect(pathB!.cursor).toBe("/brainstorming ".length)
      expect(getCursorPosition(editor)).toBe(pathB!.cursor)
    } finally {
      editor.remove()
    }
  })
})
