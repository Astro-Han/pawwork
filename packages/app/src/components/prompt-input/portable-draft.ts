/**
 * Portable homepage runtime owner (PR #750 v7).
 *
 * Holds at most ONE snapshot of the user's currently-active homepage draft.
 * Runtime only — NOT persisted to localStorage or anywhere else.
 *
 * Key rules:
 * - A session route NEVER reads or writes this owner.
 * - A homepage route writes-mirrors its draft here on every edit.
 * - On homepage→homepage navigation with an empty target, the snapshot "moves"
 *   (sourceFilesystemDirectory becomes the new homepage's dir).
 * - `revision` is a monotonic counter; submit lifecycle can guard stale clears.
 */

import { createSignal } from "solid-js"
import type { Prompt, ContextItem, ImageAttachmentPart } from "@/context/prompt"
import type { ResolvedMention } from "./mention-metadata"

export interface PortableDraftPayload {
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  images: ImageAttachmentPart[]
  /** Comment-mention metadata indexed by context item key, captured when the comment text was committed. */
  resolvedMentions: Record<string, ResolvedMention[]>
}

export interface PortableDraftSnapshot extends PortableDraftPayload {
  /** True filesystem directory the snapshot is currently anchored to. */
  sourceFilesystemDirectory: string
  /** Monotonic revision counter. Increments on every content change AND on every successful move. */
  revision: number
}

export interface PortableDraftOwner {
  /** Returns the current snapshot if any, else null. Reactive (Solid signal accessor). */
  snapshot(): PortableDraftSnapshot | null
  /** Returns the current revision, or 0 when no snapshot exists. Reactive. */
  revision(): number
  /**
   * Mirror the active homepage's draft into the owner.
   * - If the payload is "empty" (no meaningful prompt text, no context, no images,
   *   no resolvedMentions), the snapshot is cleared.
   * - If unchanged from the last record (deep-equal payload AND same sourceFilesystemDirectory),
   *   revision is NOT bumped.
   * - Otherwise revision is incremented.
   */
  record(input: { sourceFilesystemDirectory: string } & PortableDraftPayload): void
  /**
   * Consume the snapshot for a new homepage target. Returns the snapshot only if:
   * - A snapshot exists.
   * - `targetSourceFilesystemDirectory !== snapshot.sourceFilesystemDirectory`.
   * - `targetIsEmpty === true`.
   * After consumption, the snapshot's `sourceFilesystemDirectory` becomes
   * `targetSourceFilesystemDirectory` and revision is incremented. (It "moved".)
   */
  consumeForHomepage(targetSourceFilesystemDirectory: string, targetIsEmpty: boolean): PortableDraftSnapshot | null
  /** Marker for "current route is not a homepage"; snapshot is preserved (currently a no-op). */
  hide(): void
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
          prompt: input.prompt,
          context: input.context,
          images: input.images,
          resolvedMentions: input.resolvedMentions,
        })
    ) {
      return
    }

    setSnapshot({
      prompt: input.prompt,
      context: input.context,
      images: input.images,
      resolvedMentions: input.resolvedMentions,
      sourceFilesystemDirectory: input.sourceFilesystemDirectory,
      revision: nextRevision,
    })
  }

  function consumeForHomepage(
    targetSourceFilesystemDirectory: string,
    targetIsEmpty: boolean,
  ): PortableDraftSnapshot | null {
    const current = snapshot()
    if (!current) return null
    if (current.sourceFilesystemDirectory === targetSourceFilesystemDirectory) return null
    if (!targetIsEmpty) return null

    // Move: update source dir and bump revision.
    const moved: PortableDraftSnapshot = {
      ...current,
      sourceFilesystemDirectory: targetSourceFilesystemDirectory,
      revision: current.revision + 1,
    }
    setSnapshot(moved)
    return moved
  }

  function hide(): void {
    // Currently a no-op — snapshot is preserved across route changes.
    // Future tasks may track a hidden flag here.
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

  return { snapshot, revision, record, consumeForHomepage, hide, restore, clear }
}

// ---------------------------------------------------------------------------
// Module-level singleton accessed via usePortableDraft().
// ---------------------------------------------------------------------------

const owner = createPortableDraftOwner()

/** Access the app-wide portable homepage draft owner. */
export function usePortableDraft(): PortableDraftOwner {
  return owner
}

/** Testing-only: reset the module singleton between test runs. */
export const _portableDraftTesting = {
  reset: () => owner.clear(),
}
