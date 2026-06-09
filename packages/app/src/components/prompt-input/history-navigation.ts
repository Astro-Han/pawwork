// Prompt input history (persisted entries, apply, navigate). A complete
// subsystem: two persisted stores (normal + shell), apply logic, navigation
// logic, and comment synchronization.
//
// History is scoped per workspace directory (Task 3 of PR #750).
// ArrowUp in workspace B no longer surfaces entries typed in workspace A.

import { createEffect, createSignal, on } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { selectionFromLines } from "@/context/file"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { useComments } from "@/context/comments"
import { useSDK } from "@/context/sdk"
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
import { createDirectoryHistoryStore, MAX_DIRECTORY_CACHE } from "./history-store-factory"
import { buildCommentByIDMap } from "./history-comment-map"

// --- Per-directory cache types ---

type DirectoryHistoryStores = {
  history: ReturnType<typeof createDirectoryHistoryStore>
  shellHistory: ReturnType<typeof createDirectoryHistoryStore>
  /** LRU order: bump on each access so we can evict oldest. */
  lastUsed: number
}

export interface HistoryNavigationDeps {
  store: PromptStore
  setStore: SetStoreFunction<PromptStore>
  prompt: ReturnType<typeof usePrompt>
  comments: ReturnType<typeof useComments>
  editorRef: () => HTMLDivElement
  queueScroll: () => void
}

export interface HistoryNavigation {
  /** Accessor — returns the history store for the current directory. */
  history: () => HistoryStore
  /** Accessor — returns the shell history store for the current directory. */
  shellHistory: () => HistoryStore
  historyComments: () => PromptHistoryComment[]
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  navigateHistory: (direction: "up" | "down") => boolean
}

export function createHistoryNavigation(deps: HistoryNavigationDeps): HistoryNavigation {
  const { store, setStore, prompt, comments, editorRef, queueScroll } = deps
  const sdk = useSDK()

  // --- Per-directory store cache (LRU, capped at MAX_DIRECTORY_CACHE) ---

  const cache = new Map<string, DirectoryHistoryStores>()
  let lruClock = 0

  const ensureStores = (directory: string): DirectoryHistoryStores => {
    const existing = cache.get(directory)
    if (existing) {
      existing.lastUsed = ++lruClock
      return existing
    }

    // Prune the oldest entry when the cache is full.
    if (cache.size >= MAX_DIRECTORY_CACHE) {
      let oldestKey: string | undefined
      let oldestTime = Infinity
      for (const [key, entry] of cache) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed
          oldestKey = key
        }
      }
      if (oldestKey) cache.delete(oldestKey)
    }

    const stores: DirectoryHistoryStores = {
      history: createDirectoryHistoryStore(directory, "normal"),
      shellHistory: createDirectoryHistoryStore(directory, "shell"),
      lastUsed: ++lruClock,
    }
    cache.set(directory, stores)
    return stores
  }

  // Reactive accessors — always read from the current directory's stores.
  const currentStores = () => ensureStores(sdk.directory)
  const history = () => currentStores().history.store
  const shellHistory = () => currentStores().shellHistory.store

  // Pre-warm the cache for the current directory while we are still inside
  // Solid setup (where useContext works). createDirectoryHistoryStore reaches
  // persisted() which calls usePlatform(); calling that lazily from a submit
  // async tail would land outside the reactive root and throw.
  ensureStores(sdk.directory)

  // --- Directory-change token for rAF stale guard ---
  //
  // Increments every time sdk.directory changes.  The rAF callback compares
  // its captured token to the live value; if they differ, the directory
  // changed between schedule and execution, and the DOM write is abandoned.
  const [directoryToken, setDirectoryToken] = createSignal(0)

  createEffect(
    on(
      () => sdk.directory,
      (dir) => {
        // Pre-warm the cache for the new directory inside the reactive root
        // so later cache reads from outside the root are guaranteed hits.
        ensureStores(dir)
        setDirectoryToken((t) => t + 1)
        // Also reset navigation state so ArrowUp in the new workspace
        // doesn't resume mid-navigation from the previous workspace.
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
      },
      { defer: true },
    ),
  )

  // --- Comment helpers ---

  const historyComments = () => {
    const byID = buildCommentByIDMap(comments.all())
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
          resolvedMentions: item.resolvedMentions,
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
        resolvedMentions: item.resolvedMentions,
      })),
    )
  }

  // --- rAF stale guard ---
  //
  // Capture the directory token at schedule time.  If the directory changes
  // between the requestAnimationFrame call and its execution, the write is
  // abandoned to avoid corrupting the wrong editor's state.
  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const tokenAtSchedule = directoryToken()
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      if (directoryToken() !== tokenAtSchedule) {
        // Directory changed between schedule and frame; abandon DOM write.
        setStore("applyingHistory", false)
        return
      }
      const editor = editorRef()
      editor.focus()
      setCursorPosition(editor, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const addToHistory = (promptValue: Prompt, mode: "normal" | "shell") => {
    const stores = currentStores()
    const currentHistory = mode === "shell" ? stores.shellHistory.store : stores.history.store
    const setCurrentHistory = mode === "shell" ? stores.shellHistory.setStore : stores.history.setStore
    const next = prependHistoryEntry(currentHistory.entries, promptValue, mode === "shell" ? [] : historyComments())
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory().entries : history().entries,
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
