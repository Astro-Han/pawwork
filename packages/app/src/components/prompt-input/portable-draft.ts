/**
 * Legacy homepage migration runtime owner.
 *
 * Holds at most ONE snapshot adopted from a legacy per-workspace homepage
 * prompt store until the homepage editor can project it into the global
 * homepage prompt store. Runtime only — NOT persisted to localStorage or
 * anywhere else.
 *
 * Key rules:
 * - Normal homepage editing does NOT write to this owner.
 * - The snapshot never moves between directories.
 * - `revision` is a monotonic counter for stale-safe migration clears.
 */

import { createSignal } from "solid-js"
import type { Prompt, ContextItem, FloatingAttachment } from "@/context/prompt"
import type { ResolvedMention } from "./mention-metadata"
import { toAbsoluteFilePath } from "./path-canonical"

export interface PortableDraftPayload {
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  images: FloatingAttachment[]
  /** Comment-mention metadata indexed by context item key, captured when the comment text was committed. */
  resolvedMentions: Record<string, ResolvedMention[]>
}

export interface PortableDraftSnapshot extends PortableDraftPayload {
  /** True filesystem directory the snapshot is currently anchored to. */
  sourceFilesystemDirectory: string
  /** Monotonic revision counter. Increments on every content change and clear. */
  revision: number
}

export interface PortableDraftOwner {
  /** Returns the current snapshot if any, else null. Reactive (Solid signal accessor). */
  snapshot(): PortableDraftSnapshot | null
  /** Returns the current revision, or 0 when no snapshot exists. Reactive. */
  revision(): number
  /**
   * Copy a legacy homepage draft into the migration owner.
   * - If the payload is "empty" (no meaningful prompt text, no context, no images,
   *   no resolvedMentions), the snapshot is cleared.
   * - If unchanged from the last record (deep-equal payload AND same sourceFilesystemDirectory),
   *   revision is NOT bumped.
   * - Otherwise revision is incremented.
   */
  record(input: { sourceFilesystemDirectory: string } & PortableDraftPayload): void
  /** Returns current snapshot without mutating it. */
  restore(): PortableDraftSnapshot | null
  /**
   * Clear the snapshot.
   * Returns true if cleared.
   * Returns false if expectedRevision was provided and did not match (guards against stale clears).
   */
  clear(expectedRevision?: number): boolean
}

/**
 * Determine whether a payload carries no meaningful content.
 * Empty means: prompt has only a blank/whitespace text part (or is empty),
 * AND no context items, no images, no resolvedMentions.
 */
function isPayloadEmpty(payload: PortableDraftPayload): boolean {
  const { prompt, context, images, resolvedMentions } = payload

  const promptIsBlank =
    prompt.length === 0 ||
    (prompt.length === 1 && prompt[0]?.type === "text" && !prompt[0].content.trim())

  return (
    promptIsBlank &&
    context.length === 0 &&
    images.length === 0 &&
    Object.keys(resolvedMentions).length === 0
  )
}

export function createPortableDraftOwner(): PortableDraftOwner {
  const [snapshot, setSnapshot] = createSignal<PortableDraftSnapshot | null>(null)

  function revision(): number {
    return snapshot()?.revision ?? 0
  }

  function record(input: { sourceFilesystemDirectory: string } & PortableDraftPayload): void {
    if (isPayloadEmpty(input)) {
      setSnapshot(null)
      return
    }

    // Canonicalize file-bearing payload as it enters the owner, while the source
    // directory is still known. The editor later projects this migration snapshot
    // into the global homepage store, so buildRequestParts sees absolute paths
    // and never re-roots them under the target session directory.
    const canonicalPrompt: Prompt = input.prompt.map((part) =>
      part.type === "file" ? { ...part, path: toAbsoluteFilePath(input.sourceFilesystemDirectory, part.path) } : part,
    )
    const canonicalContext = input.context.map((item) =>
      item.type === "file" ? { ...item, path: toAbsoluteFilePath(input.sourceFilesystemDirectory, item.path) } : item,
    )

    const current = snapshot()
    const nextRevision = (current?.revision ?? 0) + 1

    // Skip if payload and source dir are identical to the current snapshot.
    if (
      current !== null &&
      current.sourceFilesystemDirectory === input.sourceFilesystemDirectory &&
      JSON.stringify({
        prompt: current.prompt,
        context: current.context,
        images: current.images,
        resolvedMentions: current.resolvedMentions,
      }) ===
        JSON.stringify({
          prompt: canonicalPrompt,
          context: canonicalContext,
          images: input.images,
          resolvedMentions: input.resolvedMentions,
        })
    ) {
      return
    }

    setSnapshot({
      prompt: canonicalPrompt,
      context: canonicalContext,
      images: input.images,
      resolvedMentions: input.resolvedMentions,
      sourceFilesystemDirectory: input.sourceFilesystemDirectory,
      revision: nextRevision,
    })
  }

  function restore(): PortableDraftSnapshot | null {
    return snapshot()
  }

  function clear(expectedRevision?: number): boolean {
    const current = snapshot()

    // Already clear.
    if (current === null) {
      // If caller passed 0 as expectedRevision (meaning "revision when nothing exists"), accept it.
      if (expectedRevision !== undefined && expectedRevision !== 0) return false
      return true
    }

    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      return false
    }

    setSnapshot(null)
    return true
  }

  return { snapshot, revision, record, restore, clear }
}

// ---------------------------------------------------------------------------
// Module-level singleton accessed via usePortableDraft().
// ---------------------------------------------------------------------------

const owner = createPortableDraftOwner()

/** Access the app-wide legacy homepage migration owner. */
export function usePortableDraft(): PortableDraftOwner {
  return owner
}

/** Testing-only: reset the module singleton between test runs. */
export const _portableDraftTesting = {
  reset: () => owner.clear(),
}
