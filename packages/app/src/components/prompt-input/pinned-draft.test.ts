import { describe, expect, test, beforeEach } from "bun:test"
import { createPinnedDraftOwner } from "./pinned-draft"
import { createPortableDraftOwner } from "./portable-draft"
import type { PinnedDraftPayload } from "./pinned-draft"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(text: string): PinnedDraftPayload {
  return {
    prompt: [{ type: "text", content: text, start: 0, end: text.length }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

function emptyPayload(): PinnedDraftPayload {
  return {
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

// ---------------------------------------------------------------------------
// adopt
// ---------------------------------------------------------------------------

describe("PinnedDraftOwner.adopt", () => {
  let owner: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    owner = createPinnedDraftOwner()
  })

  test("creates a pinned slot with revision 1 and the deep-link prompt as text", () => {
    owner.adopt({ directory: "/repo-x", prompt: "fix the bug" })
    const slot = owner.current()
    expect(slot).not.toBeNull()
    expect(slot?.revision).toBe(1)
    expect(slot?.directory).toBe("/repo-x")
    expect(slot?.prompt).toEqual([{ type: "text", content: "fix the bug", start: 0, end: 11 }])
    expect(slot?.context).toEqual([])
    expect(slot?.images).toEqual([])
    expect(slot?.resolvedMentions).toEqual({})
  })

  test("replaces existing slot when called twice with different directories", () => {
    owner.adopt({ directory: "/repo-a", prompt: "first" })
    owner.adopt({ directory: "/repo-b", prompt: "second" })
    const slot = owner.current()
    expect(slot?.directory).toBe("/repo-b")
    expect(slot?.prompt[0]).toMatchObject({ content: "second" })
    // Revision resets to 1 on each adopt (last-write-wins semantics).
    expect(slot?.revision).toBe(1)
  })

  test("replaces existing slot when called twice with same directory (latest wins)", () => {
    owner.adopt({ directory: "/repo-x", prompt: "old" })
    owner.adopt({ directory: "/repo-x", prompt: "new" })
    const slot = owner.current()
    expect(slot?.directory).toBe("/repo-x")
    expect(slot?.prompt[0]).toMatchObject({ content: "new" })
    expect(slot?.revision).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// recordEdit
// ---------------------------------------------------------------------------

describe("PinnedDraftOwner.recordEdit", () => {
  let owner: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    owner = createPinnedDraftOwner()
  })

  test("no-op when slot is null", () => {
    // No adopt before recordEdit.
    owner.recordEdit({ directory: "/repo-x", ...makePayload("hello") })
    expect(owner.current()).toBeNull()
  })

  test("no-op when directory does not match bound slot", () => {
    owner.adopt({ directory: "/repo-a", prompt: "original" })
    const revBefore = owner.revision()
    owner.recordEdit({ directory: "/repo-b", ...makePayload("different dir") })
    expect(owner.revision()).toBe(revBefore)
    expect(owner.current()?.directory).toBe("/repo-a")
  })

  test("updates content and bumps revision when directory matches", () => {
    owner.adopt({ directory: "/repo-x", prompt: "initial" })
    expect(owner.revision()).toBe(1)
    owner.recordEdit({ directory: "/repo-x", ...makePayload("edited") })
    expect(owner.revision()).toBe(2)
    expect(owner.current()?.prompt[0]).toMatchObject({ content: "edited" })
  })

  test("does not bump revision when payload deep-equal", () => {
    owner.adopt({ directory: "/repo-x", prompt: "same" })
    owner.recordEdit({ directory: "/repo-x", ...makePayload("same") })
    // Payload matches initial adopt content => no revision bump.
    expect(owner.revision()).toBe(1)
  })

  test("empty content does NOT release the slot (revision bumps, slot still bound)", () => {
    owner.adopt({ directory: "/repo-x", prompt: "something" })
    owner.recordEdit({ directory: "/repo-x", ...emptyPayload() })
    // Slot must still exist.
    expect(owner.current()).not.toBeNull()
    expect(owner.current()?.directory).toBe("/repo-x")
    // Revision bumped because content changed.
    expect(owner.revision()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// clearAll / release
// ---------------------------------------------------------------------------

describe("PinnedDraftOwner.clearAll / release", () => {
  let owner: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    owner = createPinnedDraftOwner()
  })

  test("clearAll without expectedRevision releases the slot", () => {
    owner.adopt({ directory: "/repo-x", prompt: "hello" })
    const result = owner.clearAll()
    expect(result).toBe(true)
    expect(owner.current()).toBeNull()
  })

  test("clearAll with matching revision releases", () => {
    owner.adopt({ directory: "/repo-x", prompt: "hello" })
    const rev = owner.revision()
    const result = owner.clearAll(rev)
    expect(result).toBe(true)
    expect(owner.current()).toBeNull()
  })

  test("clearAll with stale revision returns false and does not release", () => {
    owner.adopt({ directory: "/repo-x", prompt: "hello" })
    const result = owner.clearAll(999)
    expect(result).toBe(false)
    expect(owner.current()).not.toBeNull()
  })

  test("release is equivalent to clearAll(undefined)", () => {
    owner.adopt({ directory: "/repo-x", prompt: "hello" })
    owner.release()
    expect(owner.current()).toBeNull()
  })

  test("after release, recordEdit on the same directory is no-op (slot is gone, not auto-recreated)", () => {
    owner.adopt({ directory: "/repo-x", prompt: "hello" })
    owner.release()
    owner.recordEdit({ directory: "/repo-x", ...makePayload("fresh text") })
    expect(owner.current()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Coexistence with legacy migration owner
// ---------------------------------------------------------------------------

describe("PinnedDraftOwner + migration owner coexistence", () => {
  let pinned: ReturnType<typeof createPinnedDraftOwner>
  let portable: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    pinned = createPinnedDraftOwner()
    portable = createPortableDraftOwner()
  })

  test("migration owner record while pinned slot bound: migration owner still accepts another directory", () => {
    // Pinned bound to /a; migration adopts a legacy /b draft.
    pinned.adopt({ directory: "/repo-a", prompt: "pinned text" })
    portable.record({
      sourceFilesystemDirectory: "/repo-b",
      prompt: [{ type: "text", content: "portable text", start: 0, end: 13 }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    expect(pinned.current()?.directory).toBe("/repo-a")
    expect(portable.snapshot()?.sourceFilesystemDirectory).toBe("/repo-b")
    // Both owners hold independent state.
    expect(pinned.current()?.prompt[0]).toMatchObject({ content: "pinned text" })
    expect(portable.snapshot()?.prompt[0]).toMatchObject({ content: "portable text" })
  })

  test("migration owner record for the pinned directory while pinned slot bound: owners stay independent", () => {
    // Pinned is bound to /repo-x; migration owner also records for /repo-x.
    // In the real app, editor-input.ts branches so only one is updated,
    // but at the owner level both can hold state simultaneously.
    pinned.adopt({ directory: "/repo-x", prompt: "deep-link text" })
    portable.record({
      sourceFilesystemDirectory: "/repo-x",
      prompt: [{ type: "text", content: "portable text", start: 0, end: 13 }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    // Each owner is unaffected by the other.
    expect(pinned.current()?.prompt[0]).toMatchObject({ content: "deep-link text" })
    expect(portable.snapshot()?.prompt[0]).toMatchObject({ content: "portable text" })
  })

  test("after pinned.release(), recordEdit pinned no-ops but migration owner still works for that directory", () => {
    pinned.adopt({ directory: "/repo-x", prompt: "prefill" })
    pinned.release()

    // Pinned recordEdit is now a no-op (slot gone).
    pinned.recordEdit({ directory: "/repo-x", ...makePayload("new text") })
    expect(pinned.current()).toBeNull()

    // Migration owner is unaffected and still works.
    portable.record({
      sourceFilesystemDirectory: "/repo-x",
      prompt: [{ type: "text", content: "portable still works", start: 0, end: 20 }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    expect(portable.snapshot()?.prompt[0]).toMatchObject({ content: "portable still works" })
  })
})

// ---------------------------------------------------------------------------
// Mount-time hazard pin
//
// recordEdit() has no isEmpty short-circuit: an empty payload overwrites the
// pinned prefill in place. The editor-input.ts homepage owner mirror effect
// relies on {defer: true} to skip the mount-time fire so the prompt's default
// empty state never reaches recordEdit() before the hydration effect runs.
// Pinning this hazard explicitly so anyone reorganizing the mirror effect
// stays aware of why defer is load-bearing.
// ---------------------------------------------------------------------------

describe("PinnedDraftOwner.recordEdit empty-payload hazard", () => {
  test("empty payload overwrites a non-empty prefill in place", () => {
    const owner = createPinnedDraftOwner()
    owner.adopt({ directory: "/repo-x", prompt: "review this PR" })
    expect(owner.current()?.prompt[0]).toMatchObject({ content: "review this PR" })

    owner.recordEdit({ directory: "/repo-x", ...emptyPayload() })

    // Prefill is gone. If the mirror effect ever fires at mount with the
    // default empty prompt, this is what would happen to a pending pinned
    // prefill. defer:true on the effect is what prevents it.
    expect(owner.current()?.prompt[0]).toMatchObject({ content: "" })
  })
})
