// Thin factory for per-directory prompt-history stores.
// Kept in its own module so that tests can import it without pulling in the
// full history-navigation.ts dependency graph (which includes @/context/file).

import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import type { HistoryStore } from "./store-types"

export type DirectoryHistoryStoreResult = {
  store: HistoryStore
  setStore: ReturnType<typeof persisted<HistoryStore>>[1]
  /** Exposed for testing: the Persist target used to back this store. */
  persistTarget: ReturnType<typeof Persist.workspace>
}

/**
 * Creates a persisted history store scoped to a single filesystem directory.
 * No legacy fallback keys are passed — per v7, old global history is ignored.
 */
export function createDirectoryHistoryStore(
  directory: string,
  mode: "normal" | "shell",
): DirectoryHistoryStoreResult {
  const key = mode === "shell" ? "prompt-history-shell" : "prompt-history"
  const target = Persist.workspace(directory, key)
  // Do NOT pass legacy keys: old global history (prompt-history.v1 / prompt-history-shell.v1) is ignored.
  const [store, setStore] = persisted(target, createStore<HistoryStore>({ entries: [] }))
  return { store, setStore, persistTarget: target }
}

/** Maximum number of per-directory caches to keep in memory. */
export const MAX_DIRECTORY_CACHE = 12
