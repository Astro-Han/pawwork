// Loads an edit / followup draft into the editor when props.edit changes.
// Extracted from prompt-input.tsx; sets up one deferred createEffect keyed on the
// edit id, so it must be called synchronously inside the component owner.

import { createEffect, on } from "solid-js"
import type { SetStoreFunction } from "solid-js/store"
import { type Prompt, type usePrompt } from "@/context/prompt"
import { setCursorPosition } from "./editor-dom"
import { promptLength } from "./history"
import type { PromptStore } from "./store-types"
import type { FollowupDraft } from "./followup-draft"

export interface EditLoadEffectDeps {
  prompt: ReturnType<typeof usePrompt>
  setStore: SetStoreFunction<PromptStore>
  editorRef: () => HTMLDivElement
  queueScroll: () => void
  editDraft: () => { id: string; prompt: Prompt; context: FollowupDraft["context"] } | undefined
  onEditLoaded: () => void
}

export function createEditLoadEffect(deps: EditLoadEffectDeps): void {
  const { prompt, setStore, editorRef, queueScroll, editDraft, onEditLoaded } = deps

  createEffect(
    on(
      () => editDraft()?.id,
      (id) => {
        const edit = editDraft()
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editorRef().focus()
          setCursorPosition(editorRef(), promptLength(edit.prompt))
          queueScroll()
        })
        onEditLoaded()
      },
      { defer: true },
    ),
  )
}
