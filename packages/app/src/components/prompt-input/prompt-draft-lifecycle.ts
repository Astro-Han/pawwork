import type { Accessor } from "solid-js"
import type { ContextItem, Prompt, usePrompt } from "@/context/prompt"
import { isPromptEqual } from "@/context/prompt-equality"
import type { PromptRouteScope } from "@/pages/session/prompt-route-scope"
import { setCursorPosition } from "./editor-dom"
import type { usePinnedDraft } from "./pinned-draft"
import type { SubmitOwnership } from "./submit-ownership"

type PromptDraftLifecycleInput = {
  prompt: ReturnType<typeof usePrompt>
  pinned: ReturnType<typeof usePinnedDraft>
  params: Accessor<{ dir?: string; id?: string }>
  ownership: SubmitOwnership
  sourcePromptScope: PromptRouteScope
  promptScope: PromptRouteScope
  mode: "normal" | "shell"
  currentPrompt: Prompt
  submittedDraft: { prompt: Prompt; context: (ContextItem & { key: string })[] }
  commentItems: (ContextItem & { key: string })[]
  editor: () => HTMLDivElement | undefined
  promptLength: (prompt: Prompt) => number
  queueScroll: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
}

export function createPromptDraftLifecycle(input: PromptDraftLifecycleInput) {
  const {
    prompt,
    pinned,
    params,
    ownership,
    sourcePromptScope,
    promptScope,
    mode,
    currentPrompt,
    submittedDraft,
    commentItems,
    editor,
    promptLength,
    queueScroll,
    setMode,
    setPopover,
  } = input

  const removeSubmittedCommentItems = () => {
    for (const item of commentItems) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const submittedDraftStillCurrent = (scope: PromptRouteScope) => {
    if (!isPromptEqual(prompt.current(scope), currentPrompt)) return false
    return JSON.stringify(prompt.context.items(scope)) === JSON.stringify(submittedDraft.context)
  }

  // Submitted owner-backed drafts leave the live draft owner before the async
  // send settles. The owner only represents editable unsent draft state;
  // failure recovery uses submittedDraft captured above.
  const clearInput = () => {
    switch (ownership.kind) {
      case "pinned":
        prompt.reset(sourcePromptScope)
        pinned.clearAll(ownership.revision)
        break
      case "route":
        if (submittedDraftStillCurrent(ownership.scope)) {
          prompt.reset(ownership.scope)
        }
        break
    }
    setMode("normal")
    setPopover(null)
  }

  const confirmOwnerCleared = () => {
    switch (ownership.kind) {
      case "pinned":
        pinned.clearAll(ownership.revision)
        break
      case "route":
        // route store was reset synchronously by clearInput; no owner snapshot.
        break
    }
  }

  const shouldRestoreOwnerDraft = () => {
    return !prompt.hasDraft(promptScope)
  }

  const isActivePromptScope = (scope: PromptRouteScope) => {
    const active = params()
    return active.dir === scope.dir && active.id === scope.id
  }

  const restoreVisibleEditor = () => {
    if (!isActivePromptScope(promptScope)) return
    setMode(mode)
    setPopover(null)
    requestAnimationFrame(() => {
      const el = editor()
      if (!el) return
      el.focus()
      const cursorPrompt = ownership.kind === "route" ? currentPrompt : prompt.current()
      setCursorPosition(el, promptLength(cursorPrompt))
      queueScroll()
    })
  }

  const restoreInput = () => {
    switch (ownership.kind) {
      case "pinned":
        if (!shouldRestoreOwnerDraft()) return
        prompt.set(submittedDraft.prompt, promptLength(submittedDraft.prompt), promptScope)
        prompt.context.replaceAll(submittedDraft.context.map(({ key: _omit, ...rest }) => rest), promptScope)
        break
      case "route": {
        if (!shouldRestoreOwnerDraft()) return
        prompt.set(currentPrompt, promptLength(currentPrompt), promptScope)
        prompt.context.replaceAll(submittedDraft.context.map(({ key: _omit, ...rest }) => rest), promptScope)
        break
      }
    }
    restoreVisibleEditor()
  }

  return { clearInput, confirmOwnerCleared, restoreInput, removeSubmittedCommentItems, clearContext }
}
