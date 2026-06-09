/**
 * Pinned draft owner.
 *
 * Holds a directory-bound draft created exclusively by deep-link prefill.
 * It stays bound to one directory until explicitly released, separate from
 * ordinary homepage drafts in the global prompt store.
 *
 * Key rules:
 * - Only adopt() creates a pinned slot. recordEdit() never auto-creates one.
 * - Empty content does NOT release the slot; the directory binding persists.
 * - release() / clearAll() are the only ways to destroy the slot.
 * - Submit lifecycle calls clearAll(expectedRevision) for stale-safe teardown.
 */

import { createSignal } from "solid-js"
import type { Prompt, ContextItem, ImageAttachmentPart } from "@/context/prompt"
import type { ResolvedMention } from "./mention-metadata"

export interface PinnedDraftPayload {
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  images: ImageAttachmentPart[]
  resolvedMentions: Record<string, ResolvedMention[]>
}

export interface PinnedDraft extends PinnedDraftPayload {
  /** Filesystem directory the pinned scope is bound to. */
  directory: string
  /** Monotonic revision; bumps on adopt and on every content change. */
  revision: number
}

export interface PinnedDraftOwner {
  /** Returns the current pinned slot if any; null if released. Reactive. */
  current(): PinnedDraft | null
  /** Returns current revision, or 0 when not bound. Reactive. */
  revision(): number
  /**
   * Adopt a deep-link prefill. Replaces any existing pinned slot (last-write-wins).
   * The slot stays bound to `directory` until release() or clearAll() is called.
   */
  adopt(input: { directory: string; prompt: string }): void
  /**
   * Update content of the slot. Only writes if `directory` matches the bound slot.
   * Empty content does NOT release the slot.
   */
  recordEdit(input: { directory: string } & PinnedDraftPayload): void
  /**
   * Release the slot entirely. After this, current() returns null.
   * Used by submit-success and explicit discard actions.
   * Returns false if `expectedRevision` was passed and did not match (caller used stale revision).
   */
  clearAll(expectedRevision?: number): boolean
  /** Alias for clearAll(undefined). */
  release(): void
}

export function createPinnedDraftOwner(): PinnedDraftOwner {
  const [slot, setSlot] = createSignal<PinnedDraft | null>(null)

  function current(): PinnedDraft | null {
    return slot()
  }

  function revision(): number {
    return slot()?.revision ?? 0
  }

  function adopt(input: { directory: string; prompt: string }): void {
    const text = input.prompt
    const initialPrompt: Prompt = [{ type: "text", content: text, start: 0, end: text.length }]
    setSlot({
      directory: input.directory,
      prompt: initialPrompt,
      context: [],
      images: [],
      resolvedMentions: {},
      revision: 1,
    })
  }

  function recordEdit(input: { directory: string } & PinnedDraftPayload): void {
    const existing = slot()
    // No-op if no slot exists; adopt() is the only slot creator.
    if (existing === null) return
    // No-op if directory does not match the bound slot.
    if (existing.directory !== input.directory) return

    // Skip revision bump when payload is deep-equal to current content.
    const payloadEqual =
      JSON.stringify({
        prompt: existing.prompt,
        context: existing.context,
        images: existing.images,
        resolvedMentions: existing.resolvedMentions,
      }) ===
      JSON.stringify({
        prompt: input.prompt,
        context: input.context,
        images: input.images,
        resolvedMentions: input.resolvedMentions,
      })

    if (payloadEqual) return

    setSlot({
      ...existing,
      prompt: input.prompt,
      context: input.context,
      images: input.images,
      resolvedMentions: input.resolvedMentions,
      revision: existing.revision + 1,
    })
  }

  function clearAll(expectedRevision?: number): boolean {
    const existing = slot()

    if (existing === null) {
      // Already clear; accept any call without expectedRevision or with 0.
      if (expectedRevision !== undefined && expectedRevision !== 0) return false
      return true
    }

    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      return false
    }

    setSlot(null)
    return true
  }

  function release(): void {
    clearAll(undefined)
  }

  return { current, revision, adopt, recordEdit, clearAll, release }
}

// ---------------------------------------------------------------------------
// Module-level singleton accessed via usePinnedDraft().
// ---------------------------------------------------------------------------

const owner = createPinnedDraftOwner()

/** Access the app-wide pinned deep-link draft owner. */
export function usePinnedDraft(): PinnedDraftOwner {
  return owner
}

/** Testing-only: reset the module singleton between test runs. */
export const _pinnedDraftTesting = {
  reset: () => owner.release(),
}
