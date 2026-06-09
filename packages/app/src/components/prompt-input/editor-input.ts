// Editor input path: contenteditable input/IME events, DOM <-> store
// reconciliation, and addPart insertion. Pairs with editor-imperatives
// (which mutates the editor) — this module reads from the editor and
// reflects state into the prompt store.

import { createEffect, createSignal, on, type Accessor } from "solid-js"
import { createOwnerMirrorEffect } from "./owner-mirror"
import type { SetStoreFunction } from "solid-js/store"
import { type ContentPart, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { DEFAULT_PROMPT, isPromptEqual } from "@/context/prompt-equality"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { useParams } from "@solidjs/router"
import { usePortableDraft } from "./portable-draft"
import { usePinnedDraft } from "./pinned-draft"
import { buildSlashRegistry } from "./command-text-part"
import { tryPathBConversion } from "./command-space-trigger"
import { matchSlashTrigger } from "./slash-trigger"
import { rewriteRangeForCommandCopy, selectionTouchesCommandMark } from "./command-copy"
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
import type { PopoverControllers } from "./popover-controllers"
import type { PromptStore } from "./store-types"

const NON_EMPTY_TEXT = /[^\s\u200B]/

export interface EditorInputDeps {
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  prompt: ReturnType<typeof usePrompt>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  editorRef: () => HTMLDivElement
  mirror: { input: boolean }
  imperatives: Pick<EditorImperatives, "queueScroll" | "renderEditorWithCursor">
  // popover-controllers and editor-input both depend on each other (popover
  // wants addPart, editor-input wants popover handlers). The main file
  // creates editor-input first, then popover-controllers, and only then
  // initializes popoversRef. The factory MUST throw if a caller reaches in
  // before init, so we never silently drop @/slash input events.
  popovers: () => PopoverControllers
  closePopover: () => void
  resetHistoryNavigation: () => void
}

export interface EditorInput {
  composing: Accessor<boolean>
  isImeComposing: (event: KeyboardEvent) => boolean
  handleBlur: () => void
  handleCompositionStart: () => void
  handleCompositionEnd: () => void
  handleInput: (event?: InputEvent) => void
  handleCopy: (event: ClipboardEvent) => void
  addPart: (part: ContentPart) => boolean
}

export function createEditorInput(deps: EditorInputDeps): EditorInput {
  const {
    store,
    setStore,
    prompt,
    sdk,
    sync,
    imageAttachments,
    editorRef,
    mirror,
    imperatives,
    popovers,
    closePopover,
    resetHistoryNavigation,
  } = deps

  const params = useParams()
  const portable = usePortableDraft()
  // Pinned owner is created once per factory call (not inside handleInput).
  const pinned = usePinnedDraft()

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) =>
    event.isComposing || composing() || event.keyCode === 229

  const reconcile = (input: Prompt) => {
    const editor = editorRef()
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor(editor)) return

      imperatives.renderEditorWithCursor(input, prompt.cursor())
      return
    }

    const dom = parseEditorToParts(editor)
    if (isNormalizedEditor(editor) && isPromptEqual(input, dom)) return

    // Store-originated reconcile (Path B Space-trigger, Path C paste, Backspace
    // ladder, popover select, history navigation): the prompt store already
    // holds the target cursor. currentCursor() would read the pre-repaint DOM
    // selection, which is stale whenever the editor has not yet caught up to
    // the new prompt (e.g. Path C paste was preventDefault'd so DOM is empty).
    imperatives.renderEditorWithCursor(input, prompt.cursor())
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

  // Homepage owner mirror — single source of truth for pinned draft recording.
  // Normal homepage drafts live in the global PromptProvider store; the mirror
  // only keeps explicit deep-link pinned slots in sync while the user edits
  // them. See owner-mirror.ts for the defer / scopeChanged / composing guard
  // semantics.
  createOwnerMirrorEffect({
    prompt: () => prompt.current(),
    contextItems: () => prompt.context.items(),
    images: imageAttachments,
    directory: () => sdk.directory,
    sessionID: () => params.id,
    composing,
    pinned,
  })

  // Centralized "is the homepage draft empty" check.
  // The prompt store, the context-item store, AND the imageAttachments accessor
  // are three independent surfaces. A homepage with chips or images is NOT
  // empty even if the text part is whitespace — using a text-only check would
  // overwrite those surfaces on pinned or migration hydration.
  const isHomepageDraftEmpty = () => {
    const parts = prompt.current()
    const textIsEmpty =
      parts.length === 0 ||
      (parts.length === 1 && parts[0]?.type === "text" && !parts[0].content.trim())
    if (!textIsEmpty) return false
    if (prompt.context.items().length > 0) return false
    if (imageAttachments().length > 0) return false
    return true
  }

  createEffect(
    on(
      () => [sdk.directory, prompt.ready(), params.id] as const,
      ([dir, ready, sessionID]) => {
        if (!ready || !dir) return
        if (sessionID) {
          // Concrete session route: homepage draft owners do not hydrate here.
          return
        }

        // Homepage route: check pinned scope before migration adoption.
        // If a pinned slot is bound to this directory, project it into the
        // displayed prompt and suppress migration adoption for this homepage.
        const pinnedSlot = pinned.current()
        if (pinnedSlot && pinnedSlot.directory === dir) {
          const isEmpty = isHomepageDraftEmpty()
          if (isEmpty) {
            // Replay the full Prompt array (file/agent/text parts) directly.
            // The snapshot already stored a well-formed Prompt; reconstructing
            // from text-only would silently drop attachment parts (Bug 6).
            prompt.set(pinnedSlot.prompt, undefined)
            prompt.context.replaceAll(pinnedSlot.context.map(({ key: _omit, ...rest }) => rest))
          }
          // Do NOT fall through to migration adoption while pinned is active.
          return
        }

        // Homepage route: adopt a one-shot migrated homepage draft for this
        // directory. This preserves legacy route-scoped homepage drafts without
        // moving ordinary drafts between workspaces.
        const isEmpty = isHomepageDraftEmpty()
        const migrated = portable.restore()
        if (!isEmpty || !migrated || migrated.sourceFilesystemDirectory !== dir) return
        prompt.set(migrated.prompt, undefined)
        prompt.context.replaceAll(
          migrated.context.map(({ key: _omitKey, ...rest }) => rest),
        )
        portable.clear(migrated.revision)
      },
    ),
  )

  const handleInput = (event?: InputEvent) => {
    const editor = editorRef()
    const rawParts = parseEditorToParts(editor)
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editor)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")

    // Path B: Space-typed conversion of `/<known-name>` into a marked TextPart.
    // The browser fires inputType="insertText" with data=" " only when the user
    // types a single Space character — naturally false on paste, Backspace,
    // IME commit, and programmatic mutations. No flag state machine needed.
    if (!composing()) {
      const registry = buildSlashRegistry(sync.data.command)
      const pathB = tryPathBConversion({
        inputType: event?.inputType,
        data: event?.data,
        rawText,
        images,
        registry,
      })
      if (pathB) {
        closePopover()
        resetHistoryNavigation()
        // Do NOT set mirror.input=true here. The DOM still holds the raw
        // "/<name> " text node; only the prompt store gets the marked
        // TextPart. Letting reconcile run the non-mirror branch is what
        // forces the editor to repaint into pill DOM. Marking as mirror
        // would short-circuit on isNormalizedEditor() and leave raw text
        // visible to the user (#778 main acceptance path).
        prompt.set(pathB.prompt, pathB.cursor)
        return
      }
    }
    const hasNonText = rawParts.some((part) => part.type !== "text")
    // Context chips (drag/drop, picker, hand-off draft, comment hydration) live
    // in prompt.context.items() and don't appear as editor parts, so we have to
    // include them — otherwise an empty textarea with existing chips would hit
    // the reset branch and record {empty} into the owner, clearing ownership
    // while the chips are still rendered.
    const shouldReset =
      !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0 && prompt.context.items().length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      imperatives.queueScroll()
      // Owner clear is handled by the prompt store for ordinary homepage
      // drafts; pinned slots are mirrored by the homepage owner effect above.
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const beforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = beforeCursor.match(/@(\S*)$/)
      const slashMatch = matchSlashTrigger(beforeCursor)
      // When a leading marked command owns the turn (Path D / session.command),
      // a "/" in its args must NOT open the skill picker: that submit path drops
      // structured skill parts, so an inserted chip would silently vanish. The
      // slash stays literal command-argument text instead.
      const leadingCommand = rawParts[0]?.type === "text" && !!rawParts[0].command

      if (atMatch) {
        popovers().atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch && !leadingCommand) {
        popovers().slashOnInput(slashMatch.query, slashMatch.offset > 0)
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
    // Owner mirror is handled by the homepage owner mirror effect above.
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

    if (part.type === "file" || part.type === "agent" || part.type === "skill") {
      const cursorPosition = getCursorPosition(editor)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      // Replace the typed trigger token with the pill: "@query" for file/agent,
      // "/query" for skill. For skill the SLASH_TRIGGER group 1 boundary char
      // (space / CJK) is left in place — only the slash and query are replaced.
      let replaceStart: number | undefined
      if (part.type === "skill") {
        const slashMatch = matchSlashTrigger(textBeforeCursor)
        if (slashMatch) replaceStart = slashMatch.offset
      } else {
        const atMatch = textBeforeCursor.match(/@(\S*)$/)
        if (atMatch) replaceStart = atMatch.index ?? cursorPosition - atMatch[0].length
      }

      if (replaceStart !== undefined) {
        setRangeEdge(editor, range, "start", replaceStart)
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

  // Scoped copy handler: intercepts when selection touches any [data-cmd-mark]
  // pill and rewrites text/plain to substitute the pill with `/<dataset.name>`.
  // Browser default copies the visible textContent (just `<name>`, no slash),
  // which would lose the slash for Path C paste / cross-app round-trip.
  // Selections that do NOT touch a pill are untouched — default copy proceeds.
  const handleCopy = (event: ClipboardEvent) => {
    const editor = editorRef()
    if (!selectionTouchesCommandMark(editor)) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    event.preventDefault()
    const rewritten = rewriteRangeForCommandCopy(sel.getRangeAt(0))
    event.clipboardData?.setData("text/plain", rewritten)
  }

  return {
    composing,
    isImeComposing,
    handleBlur,
    handleCompositionStart,
    handleCompositionEnd,
    handleInput,
    handleCopy,
    addPart,
  }
}
