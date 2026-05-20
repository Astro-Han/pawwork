// Keyboard event router for the composer editor. Dispatches to popover,
// history, shell-mode, file-pick, submit/abort subsystems based on the
// active key combination.

import type { Accessor } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import type { ContentPart, TextPart, usePrompt } from "@/context/prompt"
import { canNavigateHistoryAtCursor } from "./history"
import { getCursorPosition } from "./editor-dom"
import { promptKeyActionReady } from "./readiness"
import type { PromptStore } from "./store-types"
import { computeCommandBackspaceResult } from "./command-backspace"

export interface PromptKeydownDeps {
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  editorRef: () => HTMLDivElement
  prompt: ReturnType<typeof usePrompt>
  working: Accessor<boolean>
  stopping: Accessor<boolean>
  actionReady: Accessor<boolean>
  abortReady: Accessor<boolean>
  // popover handlers
  selectPopoverActive: () => void
  atOnKeyDown: (event: KeyboardEvent) => void
  slashOnKeyDown: (event: KeyboardEvent) => void
  closePopover: () => void
  // editor imperatives
  getCaretState: () => { collapsed: boolean; cursorPosition: number; textLength: number }
  escBlur: () => boolean
  // editor input
  addPart: (part: ContentPart) => boolean
  isImeComposing: (event: KeyboardEvent) => boolean
  // history navigation
  navigateHistory: (direction: "up" | "down") => boolean
  // submit / mode / file pick
  pick: () => void
  abort: (source?: "stopButton" | "emptyEnter" | "ctrlG" | "escape") => void
  handleSubmit: (event: KeyboardEvent) => void
}

export function createPromptKeydownHandler(deps: PromptKeydownDeps): (event: KeyboardEvent) => void {
  const {
    store,
    setStore,
    editorRef,
    prompt,
    working,
    stopping,
    actionReady,
    abortReady,
    selectPopoverActive,
    atOnKeyDown,
    slashOnKeyDown,
    closePopover,
    getCaretState,
    escBlur,
    addPart,
    isImeComposing,
    navigateHistory,
    pick,
    abort,
    handleSubmit,
  } = deps

  return (event: KeyboardEvent) => {
    if (
      !promptKeyActionReady({
        key: event.key,
        working: working(),
        stopping: stopping(),
        actionReady: actionReady(),
        abortReady: abortReady(),
      })
    ) {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        // Pre-check: if leading TextPart is command-marked and caret is inside
        // or immediately after the "/<name> " prefix, apply the fallback ladder
        // instead of the browser default delete.
        const parts = prompt.current()
        const first = parts[0]
        if (first?.type === "text" && first.command) {
          const prefix = `/${first.command.name} `
          const cursorPos = getCursorPosition(editorRef())
          // "Adjacent to pill": caret logical position <= prefix length covers
          // caret-before-pill (0), caret-inside-pill, and caret-right-after-pill.
          if (cursorPos <= prefix.length) {
            event.preventDefault()
            const markedFirst = first as TextPart & { command: NonNullable<TextPart["command"]> }
            const newParts = computeCommandBackspaceResult(parts, markedFirst, prefix)
            prompt.set(newParts, 0)
            return
          }
        }

        // Existing ZWSP cleanup: move caret to start of a ZWSP-only text node
        // so the next keydown deletes the sentinel rather than real content.
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef())
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        abort("escape")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef().blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        abort("ctrlG")
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef())
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      handleSubmit(event)
    }
  }
}
