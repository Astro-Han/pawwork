// Tests for scoped command-copy clipboard rewrite.
// Spec: §Pill DOM → Copy contract (L164-174).

import { describe, expect, test } from "bun:test"
import { rewriteRangeForCommandCopy, selectionTouchesCommandMark } from "./command-copy"

function buildPill(name: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.dataset.cmdMark = "true"
  span.dataset.name = name
  span.contentEditable = "false"
  const icon = document.createElement("span")
  icon.dataset.cmdIcon = "true"
  span.appendChild(icon)
  const label = document.createElement("span")
  label.dataset.cmdLabel = "true"
  label.textContent = name
  span.appendChild(label)
  return span
}

function mountEditor(builder: (editor: HTMLElement) => void): HTMLElement {
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  builder(editor)
  document.body.appendChild(editor)
  return editor
}

describe("rewriteRangeForCommandCopy", () => {
  test("selecting only the pill yields '/<name>'", () => {
    const editor = mountEditor((e) => {
      e.appendChild(buildPill("brainstorming"))
      e.appendChild(document.createTextNode(" hello"))
    })
    try {
      const range = document.createRange()
      range.selectNode(editor.firstChild!)
      expect(rewriteRangeForCommandCopy(range)).toBe("/brainstorming")
    } finally { editor.remove() }
  })

  test("selecting pill + adjacent args yields '/<name> args'", () => {
    const editor = mountEditor((e) => {
      e.appendChild(buildPill("brainstorming"))
      e.appendChild(document.createTextNode(" hello"))
    })
    try {
      const range = document.createRange()
      range.setStartBefore(editor.firstChild!)
      range.setEndAfter(editor.lastChild!)
      expect(rewriteRangeForCommandCopy(range)).toBe("/brainstorming hello")
    } finally { editor.remove() }
  })

  test("multiple pills in selection each rewrite to /<name>", () => {
    const editor = mountEditor((e) => {
      e.appendChild(buildPill("a"))
      e.appendChild(document.createTextNode(" "))
      e.appendChild(buildPill("b"))
    })
    try {
      const range = document.createRange()
      range.selectNodeContents(editor)
      expect(rewriteRangeForCommandCopy(range)).toBe("/a /b")
    } finally { editor.remove() }
  })

  test("<br> inside range becomes \\n", () => {
    const editor = mountEditor((e) => {
      e.appendChild(buildPill("cmd"))
      e.appendChild(document.createTextNode(" line1"))
      e.appendChild(document.createElement("br"))
      e.appendChild(document.createTextNode("line2"))
    })
    try {
      const range = document.createRange()
      range.selectNodeContents(editor)
      expect(rewriteRangeForCommandCopy(range)).toBe("/cmd line1\nline2")
    } finally { editor.remove() }
  })
})

describe("selectionTouchesCommandMark", () => {
  test("selection touching pill → true", () => {
    const editor = mountEditor((e) => {
      e.appendChild(buildPill("cmd"))
      e.appendChild(document.createTextNode(" args"))
    })
    try {
      const range = document.createRange()
      range.selectNode(editor.firstChild!)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      expect(selectionTouchesCommandMark(editor)).toBe(true)
    } finally { editor.remove() }
  })

  test("selection in text-only region (no pill) → false", () => {
    const editor = mountEditor((e) => {
      e.appendChild(document.createTextNode("hello world"))
    })
    try {
      const range = document.createRange()
      range.setStart(editor.firstChild!, 0)
      range.setEnd(editor.firstChild!, 5)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      expect(selectionTouchesCommandMark(editor)).toBe(false)
    } finally { editor.remove() }
  })

  test("@file pill (data-type=file) but no data-cmd-mark → false", () => {
    const editor = mountEditor((e) => {
      const filePill = document.createElement("span")
      filePill.dataset.type = "file"
      filePill.textContent = "@foo.ts"
      e.appendChild(filePill)
    })
    try {
      const range = document.createRange()
      range.selectNode(editor.firstChild!)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      expect(selectionTouchesCommandMark(editor)).toBe(false)
    } finally { editor.remove() }
  })

  test("no selection → false", () => {
    const editor = mountEditor((e) => {
      e.appendChild(buildPill("cmd"))
    })
    try {
      const sel = window.getSelection()!
      sel.removeAllRanges()
      expect(selectionTouchesCommandMark(editor)).toBe(false)
    } finally { editor.remove() }
  })
})
