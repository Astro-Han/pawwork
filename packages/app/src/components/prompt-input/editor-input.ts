// Editor input path: contenteditable input/IME events, DOM <-> store
// reconciliation, and addPart insertion. Pairs with editor-imperatives
// (which mutates the editor) — this module reads from the editor and
// reflects state into the prompt store.

import { createEffect, createSignal, on, type Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import {
  type ContentPart,
  DEFAULT_PROMPT,
  type ImageAttachmentPart,
  isPromptEqual,
  type Prompt,
  type usePrompt,
} from "@/context/prompt"
import type { useSDK } from "@/context/sdk"
import { recordDraftEdit, consumeCarryOver } from "./draft-carryover"
import {
  createTextFragment,
  getCursorPosition,
  setCursorPosition,
  setRangeEdge,
} from "./editor-dom"
import {
  createPill,
  isNormalizedEditor,
  parseEditorToParts,
} from "./editor-serialize"
import { promptLength } from "./history"
import type { EditorImperatives } from "./editor-imperatives"
import type { PromptStore } from "./store-types"

const NON_EMPTY_TEXT = /[^\s\u200B]/

export interface EditorInputDeps {
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  prompt: ReturnType<typeof usePrompt>
  sdk: ReturnType<typeof useSDK>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  editorRef: () => HTMLDivElement
  mirror: { input: boolean }
  imperatives: Pick<EditorImperatives, "queueScroll" | "renderEditorWithCursor">
  // Popover handlers come from the main file's closure for now; commit 6
  // converts these to a `popovers()` ref forward when popover-controllers is
  // extracted, since editor-input.addPart and popover-controllers.addPart
  // form a circular dep.
  atOnInput: (query: string) => void
  slashOnInput: (query: string) => void
  closePopover: () => void
  resetHistoryNavigation: () => void
}

export interface EditorInput {
  composing: Accessor<boolean>
  isImeComposing: (event: KeyboardEvent) => boolean
  handleBlur: () => void
  handleCompositionStart: () => void
  handleCompositionEnd: () => void
  handleInput: () => void
  addPart: (part: ContentPart) => boolean
}

export function createEditorInput(deps: EditorInputDeps): EditorInput {
  const {
    store,
    setStore,
    prompt,
    sdk,
    imageAttachments,
    editorRef,
    mirror,
    imperatives,
    atOnInput,
    slashOnInput,
    closePopover,
    resetHistoryNavigation,
  } = deps

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) =>
    event.isComposing || composing() || event.keyCode === 229

  const reconcile = (input: Prompt) => {
    const editor = editorRef()
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor(editor)) return

      imperatives.renderEditorWithCursor(input)
      return
    }

    const dom = parseEditorToParts(editor)
    if (isNormalizedEditor(editor) && isPromptEqual(input, dom)) return

    imperatives.renderEditorWithCursor(input)
  }

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  createEffect(
    on(
      () => [sdk.directory, prompt.ready()] as const,
      ([dir, ready]) => {
        if (!ready || !dir) return
        const parts = prompt.current()
        const isEmpty =
          parts.length === 0 ||
          (parts.length === 1 && parts[0]?.type === "text" && !parts[0].content.trim())
        const carry = consumeCarryOver(dir, isEmpty)
        if (!carry) return
        const text = carry.text
        prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      },
    ),
  )

  const handleInput = () => {
    const editor = editorRef()
    const rawParts = parseEditorToParts(editor)
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editor)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      imperatives.queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    recordDraftEdit(sdk.directory, { text: rawText })
    imperatives.queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const editor = editorRef()
    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
      editor.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editor, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editor)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editor, range, "start", start)
        setRangeEdge(editor, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  return {
    composing,
    isImeComposing,
    handleBlur,
    handleCompositionStart,
    handleCompositionEnd,
    handleInput,
    addPart,
  }
}
