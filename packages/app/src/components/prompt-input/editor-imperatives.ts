// Imperative side-effects on the contenteditable editor (cursor, scroll, focus).
// All helpers operate via the editorRef/scrollRef getters; nothing here is reactive.

import type { Prompt, usePrompt } from "@/context/prompt"
import type { usePlatform } from "@/context/platform"
import { getCursorPosition, setCursorPosition } from "./editor-dom"
import { renderPartsToEditor } from "./editor-serialize"
import { promptLength } from "./history"

export interface EditorImperativesDeps {
  editorRef: () => HTMLDivElement
  scrollRef: () => HTMLDivElement
  prompt: ReturnType<typeof usePrompt>
  platform: ReturnType<typeof usePlatform>
  inset: number
}

export interface EditorImperatives {
  scrollCursorIntoView: () => void
  queueScroll: (count?: number) => void
  clearEditor: () => void
  setEditorText: (text: string) => void
  focusEditorEnd: () => void
  currentCursor: () => number | null
  restoreFocus: () => void
  renderEditorWithCursor: (parts: Prompt) => void
  getCaretState: () => { collapsed: boolean; cursorPosition: number; textLength: number }
  escBlur: () => boolean
}

export function createEditorImperatives(deps: EditorImperativesDeps): EditorImperatives {
  const { editorRef, scrollRef, prompt, platform, inset } = deps

  const scrollCursorIntoView = () => {
    const container = scrollRef()
    const editor = editorRef()
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return

    const cursor = getCursorPosition(editor)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const clearEditor = () => {
    editorRef().innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef().textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      const editor = editorRef()
      editor.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editor)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const editor = editorRef()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null
    return getCursorPosition(editor)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const editor = editorRef()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editor.focus()
      setCursorPosition(editor, cursor)
      queueScroll()
    })
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const editor = editorRef()
    const cursor = currentCursor()
    renderPartsToEditor(editor, parts)
    if (cursor !== null) setCursorPosition(editor, cursor)
  }

  const getCaretState = () => {
    const editor = editorRef()
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editor.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editor),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  return {
    scrollCursorIntoView,
    queueScroll,
    clearEditor,
    setEditorText,
    focusEditorEnd,
    currentCursor,
    restoreFocus,
    renderEditorWithCursor,
    getCaretState,
    escBlur,
  }
}
