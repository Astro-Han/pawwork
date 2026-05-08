// Prompt input history (persisted entries, apply, navigate). A complete
// subsystem: two persisted stores (normal + shell), apply logic, navigation
// logic, and comment synchronization.

import { createStore, type SetStoreFunction } from "solid-js/store"
import { selectionFromLines } from "@/context/file"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { useComments } from "@/context/comments"
import { Persist, persisted } from "@/utils/persist"
import { setCursorPosition } from "./editor-dom"
import {
  navigatePromptHistory,
  prependHistoryEntry,
  promptLength,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
} from "./history"
import type { HistoryStore, PromptStore } from "./store-types"

export interface HistoryNavigationDeps {
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  prompt: ReturnType<typeof usePrompt>
  comments: ReturnType<typeof useComments>
  editorRef: () => HTMLDivElement
  queueScroll: () => void
}

export interface HistoryNavigation {
  history: HistoryStore
  shellHistory: HistoryStore
  historyComments: () => PromptHistoryComment[]
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  navigateHistory: (direction: "up" | "down") => boolean
}

export function createHistoryNavigation(deps: HistoryNavigationDeps): HistoryNavigation {
  const { store, setStore, prompt, comments, editorRef, queueScroll } = deps

  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<HistoryStore>({ entries: [] }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<HistoryStore>({ entries: [] }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? {
              start: item.selection.startLine,
              end: item.selection.endLine,
            }
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      const editor = editorRef()
      editor.focus()
      setCursorPosition(editor, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const addToHistory = (promptValue: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, promptValue, mode === "shell" ? [] : historyComments())
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  return {
    history,
    shellHistory,
    historyComments,
    addToHistory,
    navigateHistory,
  }
}
