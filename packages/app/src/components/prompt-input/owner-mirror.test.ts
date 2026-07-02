// Tests for applyOwnerMirrorTick — the decision logic the owner mirror
// effect runs on each fire. The effect itself wraps tick in
// createEffect(on(..., {defer:true})) so the mount-time invocation is
// skipped by the SolidJS framework; defer is not exercised here.
//
// What IS exercised: the three skip branches (composing, session route,
// scope change) and pinned record routing. These pin
// the regression scenarios called out in the PR review:
//
//   - pinned prefill at mount must not be overwritten in place
//   - IME compositionend must record the committed prompt without relying
//     on a post-compose input event
//
// The tests drive tick directly with synthetic state, bypassing SolidJS
// effect scheduling (which is gated by --conditions=browser in this repo
// and not enabled for `bun test`).

import { describe, expect, test } from "bun:test"
import type { ContextItem, ImageAttachmentPart, Prompt } from "@/context/prompt"
import {
  applyOwnerMirrorTick,
  type OwnerMirrorState,
  type OwnerMirrorTickInputs,
} from "./owner-mirror"
import { createPinnedDraftOwner } from "./pinned-draft"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textPrompt(text: string): Prompt {
  return [{ type: "text", content: text, start: 0, end: text.length }]
}

function emptyPrompt(): Prompt {
  return [{ type: "text", content: "", start: 0, end: 0 }]
}

function tickInputs(over: Partial<OwnerMirrorTickInputs> = {}): OwnerMirrorTickInputs {
  return {
    parts: emptyPrompt(),
    contextItems: [],
    images: [],
    dir: "/repo-x",
    sessionID: undefined,
    compose: false,
    ...over,
  }
}

function makeState(initial: Partial<OwnerMirrorState> = {}): OwnerMirrorState {
  return {
    lastSeenDir: "/repo-x",
    lastSeenSessionID: undefined,
    ...initial,
  }
}

function makeOwners() {
  return {
    pinned: createPinnedDraftOwner(),
  }
}

// ---------------------------------------------------------------------------
// composing guard
// ---------------------------------------------------------------------------

describe("applyOwnerMirrorTick — composing guard", () => {
  test("intermediate IME prompt during composing=true returns skip-composing and does not record", () => {
    const state = makeState()
    const { pinned } = makeOwners()
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("中"), compose: true }),
      state,
      pinned,
    )
    expect(outcome).toBe("skip-composing")
    expect(pinned.current()).toBeNull()
  })

  test("compositionend (compose true→false) tick wakes without recording ordinary homepage drafts", () => {
    const state = makeState()
    const { pinned } = makeOwners()

    // Tick 1: during composition (compose=true) — skipped.
    applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("中文"), compose: true }),
      state,
      pinned,
    )

    // Tick 2: compositionend fires with the committed prompt (compose=false).
    // The mirror effect tracks composing(), so this transition wakes it even
    // without a post-compose input event.
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("中文"), compose: false }),
      state,
      pinned,
    )
    expect(outcome).toBe("skip-unpinned-homepage")
    expect(pinned.current()).toBeNull()
  })

  test("composing=true does NOT update lastSeenDir/sessionID (next non-compose tick still sees current scope)", () => {
    const state = makeState({ lastSeenDir: "/repo-x" })
    const { pinned } = makeOwners()
    applyOwnerMirrorTick(
      tickInputs({ dir: "/repo-x", compose: true }),
      state,
      pinned,
    )
    // State preserved — scope change is only consumed on non-composing ticks.
    expect(state.lastSeenDir).toBe("/repo-x")
    expect(state.lastSeenSessionID).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// session-route guard
// ---------------------------------------------------------------------------

describe("applyOwnerMirrorTick — session-route guard", () => {
  test("sessionID set returns skip-session and does not record", () => {
    const state = makeState()
    const { pinned } = makeOwners()
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("typed in session"), sessionID: "session-abc" }),
      state,
      pinned,
    )
    expect(outcome).toBe("skip-session")
    expect(pinned.current()).toBeNull()
  })

  test("session → homepage transition (sessionID undefined → string change) is treated as scope change", () => {
    // Initial state: was on homepage /repo-x.
    const state = makeState({ lastSeenDir: "/repo-x", lastSeenSessionID: undefined })
    const { pinned } = makeOwners()

    // Enter session route.
    const outcome1 = applyOwnerMirrorTick(
      tickInputs({ sessionID: "session-abc" }),
      state,
      pinned,
    )
    expect(outcome1).toBe("skip-session")
    expect(state.lastSeenSessionID).toBe("session-abc")

    // Leave session, return to homepage. First tick sees scope change.
    const outcome2 = applyOwnerMirrorTick(
      tickInputs({ parts: emptyPrompt(), sessionID: undefined }),
      state,
      pinned,
    )
    expect(outcome2).toBe("skip-scope")
  })
})

// ---------------------------------------------------------------------------
// scope-change guard — the headline fix
// ---------------------------------------------------------------------------

describe("applyOwnerMirrorTick — scope-change guard", () => {
  test("homepage A → homepage B (directory change) returns skip-scope without recording", () => {
    const { pinned } = makeOwners()

    // State reflects last-seen /repo-a.
    const state = makeState({ lastSeenDir: "/repo-a" })

    // Session swap fires the effect: dir is now /repo-b.
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: emptyPrompt(), dir: "/repo-b" }),
      state,
      pinned,
    )
    expect(outcome).toBe("skip-scope")

    // State updated so the next /repo-b tick passes the guard.
    expect(state.lastSeenDir).toBe("/repo-b")
  })

  test("subsequent non-empty tick on the new dir does not record ordinary homepage drafts", () => {
    const { pinned } = makeOwners()
    const state = makeState({ lastSeenDir: "/repo-a" })

    // Scope-change tick.
    applyOwnerMirrorTick(
      tickInputs({ parts: emptyPrompt(), dir: "/repo-b" }),
      state,
      pinned,
    )

    // User types on /repo-b.
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("typed on b"), dir: "/repo-b" }),
      state,
      pinned,
    )
    expect(outcome).toBe("skip-unpinned-homepage")
  })
})

// ---------------------------------------------------------------------------
// record routing — pinned only
// ---------------------------------------------------------------------------

describe("applyOwnerMirrorTick — record routing", () => {
  test("pinned slot bound to current dir routes records to pinned", () => {
    const { pinned } = makeOwners()
    pinned.adopt({ directory: "/repo-x", prompt: "prefill" })

    const state = makeState({ lastSeenDir: "/repo-x" })
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("prefill plus edit"), dir: "/repo-x" }),
      state,
      pinned,
    )
    expect(outcome).toBe("recorded-pinned")
    expect(pinned.current()?.prompt[0]).toMatchObject({ content: "prefill plus edit" })
  })

  test("pinned slot bound to a different dir leaves ordinary homepage draft unowned", () => {
    const { pinned } = makeOwners()
    pinned.adopt({ directory: "/repo-other", prompt: "other prefill" })

    const state = makeState({ lastSeenDir: "/repo-x" })
    const outcome = applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("hello"), dir: "/repo-x" }),
      state,
      pinned,
    )
    expect(outcome).toBe("skip-unpinned-homepage")
    // Pinned slot for /repo-other is untouched.
    expect(pinned.current()?.directory).toBe("/repo-other")
    expect(pinned.current()?.prompt[0]).toMatchObject({ content: "other prefill" })
  })

  test("resolvedMentions on file context items are flattened into pinned payload", () => {
    const { pinned } = makeOwners()
    pinned.adopt({ directory: "/repo-x", prompt: "prefill" })
    const state = makeState({ lastSeenDir: "/repo-x" })
    const fileItem: ContextItem & { key: string } = {
      type: "file",
      path: "/repo-x/src/foo.ts",
      key: "file:/repo-x/src/foo.ts",
      resolvedMentions: [
        {
          displayText: "@src/bar.ts",
          resolvedPath: "/repo-x/src/bar.ts",
          fingerprint: "abc",
          start: 0,
          end: 11,
        },
      ],
    }
    applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("hello"), contextItems: [fileItem] }),
      state,
      pinned,
    )
    expect(Object.keys(pinned.current()?.resolvedMentions ?? {})).toEqual([fileItem.key])
  })

  test("image attachments are copied into the pinned payload", () => {
    const { pinned } = makeOwners()
    pinned.adopt({ directory: "/repo-x", prompt: "prefill" })
    const state = makeState({ lastSeenDir: "/repo-x" })
    const img: ImageAttachmentPart = {
      type: "image",
      id: "img-1",
      filename: "img-1.png",
      mime: "image/png",
      dataUrl: "data:image/png,abc",
    }
    applyOwnerMirrorTick(
      tickInputs({ parts: textPrompt("hi"), images: [img] }),
      state,
      pinned,
    )
    expect(pinned.current()?.images.length).toBe(1)
    expect(pinned.current()?.images[0]?.id).toBe("img-1")
  })
})

// ---------------------------------------------------------------------------
// Mount-defer regression note
//
// `{defer: true}` is part of the createEffect wiring in createOwnerMirrorEffect
// and is NOT covered by these tests. It relies on SolidJS to skip the initial
// invocation. If a future refactor strips defer, the editor-input.ts mount
// sequence would fire applyOwnerMirrorTick with DEFAULT_PROMPT at mount and
// overwrite any pinned prefill BEFORE hydration
// applies. The pinned-draft.test.ts hazard-pin tests at the owner layer remain
// the canonical proof of why defer matters.
// ---------------------------------------------------------------------------
