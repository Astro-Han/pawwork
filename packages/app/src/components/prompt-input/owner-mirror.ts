// Owner mirror effect — single source of truth for pinned draft recording.
// Extracted from editor-input.ts so the decision logic can be exercised
// end-to-end in isolation.
//
// The mirror folds three protections into one place:
//
// 1. {defer: true} skips the mount-time invocation. At mount the prompt is
//    typically DEFAULT_PROMPT (empty payload) — without defer this could call
//    pinned.recordEdit() with empty before the hydration logic in
//    editor-input.ts has a chance to apply pinned prefill. defer is a SolidJS
//    framework primitive; the unit test trusts SolidJS to honor it and only
//    exercises applyOwnerMirrorTick.
//
// 2. lastSeenDir / lastSeenSessionID skip the first fire after a route scope
//    change. Pinned deep-link hydration runs in a sibling effect; skipping the
//    scope-change tick prevents an empty homepage from overwriting the pinned
//    slot before hydration can project it.
//
// 3. composing() is tracked so the false→true and true→false transitions
//    both wake the effect. Most browsers emit an additional input event
//    after compositionend that would wake the mirror via handleInput's
//    prompt.set, but not all do; tracking composing directly guarantees an
//    owner record on IME commit regardless of the post-compositionend input
//    event.

import { createEffect, on } from "solid-js"
import type { ContextItem, FloatingAttachment, Prompt } from "@/context/prompt"
import type { ResolvedMention } from "./mention-metadata"
import type { PinnedDraftOwner } from "./pinned-draft"

export interface OwnerMirrorState {
  lastSeenDir: string
  lastSeenSessionID: string | undefined
}

export interface OwnerMirrorTickInputs {
  parts: Prompt
  contextItems: (ContextItem & { key: string })[]
  images: FloatingAttachment[]
  dir: string
  sessionID: string | undefined
  compose: boolean
}

export type OwnerMirrorTickOutcome =
  | "recorded-pinned"
  | "skip-unpinned-homepage"
  | "skip-composing"
  | "skip-session"
  | "skip-scope"

/**
 * One tick of the owner mirror state machine. Side effects: calls owner.record
 * methods. Returns an outcome tag so tests can pin which branch ran.
 *
 * Mutates `state.lastSeenDir` / `state.lastSeenSessionID` even on skip-scope so
 * a subsequent unchanged-scope tick passes the guard.
 */
export function applyOwnerMirrorTick(
  inputs: OwnerMirrorTickInputs,
  state: OwnerMirrorState,
  pinned: PinnedDraftOwner,
): OwnerMirrorTickOutcome {
  if (inputs.compose) return "skip-composing"

  const scopeChanged =
    state.lastSeenDir !== inputs.dir || state.lastSeenSessionID !== inputs.sessionID
  state.lastSeenDir = inputs.dir
  state.lastSeenSessionID = inputs.sessionID
  if (inputs.sessionID) return "skip-session"
  if (scopeChanged) return "skip-scope"

  const resolvedMentionsMap: Record<string, ResolvedMention[]> = {}
  for (const item of inputs.contextItems) {
    if (item.type === "file" && item.resolvedMentions?.length) {
      resolvedMentionsMap[item.key] = item.resolvedMentions
    }
  }

  const currentPinnedSlot = pinned.current()
  if (currentPinnedSlot && currentPinnedSlot.directory === inputs.dir) {
    pinned.recordEdit({
      directory: inputs.dir,
      prompt: inputs.parts,
      context: inputs.contextItems.slice(),
      images: [...inputs.images],
      resolvedMentions: resolvedMentionsMap,
    })
    return "recorded-pinned"
  }
  return "skip-unpinned-homepage"
}

export interface OwnerMirrorDeps {
  prompt: () => Prompt
  contextItems: () => (ContextItem & { key: string })[]
  images: () => FloatingAttachment[]
  directory: () => string
  sessionID: () => string | undefined
  composing: () => boolean
  pinned: PinnedDraftOwner
}

export function createOwnerMirrorEffect(deps: OwnerMirrorDeps): void {
  const state: OwnerMirrorState = {
    lastSeenDir: deps.directory(),
    lastSeenSessionID: deps.sessionID(),
  }
  createEffect(
    on(
      () =>
        [
          deps.prompt(),
          deps.contextItems(),
          deps.images(),
          deps.directory(),
          deps.sessionID(),
          deps.composing(),
        ] as const,
      ([parts, contextItems, images, dir, sessionID, compose]) => {
        applyOwnerMirrorTick(
          { parts, contextItems, images, dir, sessionID, compose },
          state,
          deps.pinned,
        )
      },
      { defer: true },
    ),
  )
}
