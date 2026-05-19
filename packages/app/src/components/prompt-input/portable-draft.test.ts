import { describe, expect, test, beforeEach } from "bun:test"
import { createPortableDraftOwner } from "./portable-draft"
import type { PortableDraftPayload } from "./portable-draft"
import { DEFAULT_PROMPT } from "@/context/prompt"

// Helper: build a non-empty payload
function makePayload(text: string): PortableDraftPayload {
  return {
    prompt: [{ type: "text", content: text, start: 0, end: text.length }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

// Helper: empty payload (DEFAULT_PROMPT shape)
function emptyPayload(): PortableDraftPayload {
  return {
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

describe("PortableDraftOwner.record", () => {
  let owner: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    owner = createPortableDraftOwner()
  })

  test("creates snapshot with revision 1 on first record", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    const snap = owner.snapshot()
    expect(snap).not.toBeNull()
    expect(snap?.revision).toBe(1)
    expect(snap?.sourceFilesystemDirectory).toBe("/a")
  })

  test("does not bump revision when payload deep-equal and same source dir", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.snapshot()?.revision).toBe(1)
  })

  test("bumps revision when text changes", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("world") })
    expect(owner.snapshot()?.revision).toBe(2)
  })

  test("bumps revision when context items change", () => {
    const base = makePayload("hello")
    owner.record({ sourceFilesystemDirectory: "/a", ...base })
    owner.record({
      sourceFilesystemDirectory: "/a",
      ...base,
      context: [{ type: "file", path: "/a/foo.ts", key: "file:/a/foo.ts:undefined:undefined" }],
    })
    expect(owner.snapshot()?.revision).toBe(2)
  })

  test("bumps revision when images change", () => {
    const base = makePayload("hello")
    owner.record({ sourceFilesystemDirectory: "/a", ...base })
    owner.record({
      sourceFilesystemDirectory: "/a",
      ...base,
      images: [{ type: "image", id: "img1", filename: "a.png", mime: "image/png", dataUrl: "data:..." }],
    })
    expect(owner.snapshot()?.revision).toBe(2)
  })

  test("bumps revision when resolvedMentions change", () => {
    const base = makePayload("hello")
    owner.record({ sourceFilesystemDirectory: "/a", ...base })
    owner.record({
      sourceFilesystemDirectory: "/a",
      ...base,
      resolvedMentions: {
        someKey: [
          {
            displayText: "@src/a.ts",
            resolvedPath: "/a/src/a.ts",
            fingerprint: "abc123",
            start: 0,
            end: 9,
          },
        ],
      },
    })
    expect(owner.snapshot()?.revision).toBe(2)
  })

  test("bumps revision when sourceFilesystemDirectory changes", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/b", ...makePayload("hello") })
    expect(owner.snapshot()?.revision).toBe(2)
    expect(owner.snapshot()?.sourceFilesystemDirectory).toBe("/b")
  })

  test("clears snapshot when payload becomes empty", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/a", ...emptyPayload() })
    expect(owner.snapshot()).toBeNull()
  })
})

describe("PortableDraftOwner.consumeForHomepage", () => {
  let owner: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    owner = createPortableDraftOwner()
  })

  test("returns null when no snapshot exists", () => {
    expect(owner.consumeForHomepage("/b", true)).toBeNull()
  })

  test("returns null when target dir equals source dir", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.consumeForHomepage("/a", true)).toBeNull()
  })

  test("returns null when target is not empty", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.consumeForHomepage("/b", false)).toBeNull()
  })

  test("moves snapshot to target dir and bumps revision when target empty and dirs differ", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    const snap = owner.consumeForHomepage("/b", true)
    expect(snap).not.toBeNull()
    expect(snap?.sourceFilesystemDirectory).toBe("/b")
    expect(snap?.revision).toBe(2) // original 1, move bumps to 2
    // The internal snapshot now tracks /b
    expect(owner.snapshot()?.sourceFilesystemDirectory).toBe("/b")
  })

  test("subsequent consume from same target returns null (no self-move)", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.consumeForHomepage("/b", true)
    // Now snapshot is at /b; trying to consume to /b again is self-move
    expect(owner.consumeForHomepage("/b", true)).toBeNull()
  })
})

describe("PortableDraftOwner.clear", () => {
  let owner: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    owner = createPortableDraftOwner()
  })

  test("clear without expectedRevision clears the snapshot", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    const result = owner.clear()
    expect(result).toBe(true)
    expect(owner.snapshot()).toBeNull()
  })

  test("clear with matching expectedRevision clears", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    const rev = owner.revision()
    const result = owner.clear(rev)
    expect(result).toBe(true)
    expect(owner.snapshot()).toBeNull()
  })

  test("clear with stale expectedRevision does not clear", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    const result = owner.clear(999)
    expect(result).toBe(false)
    expect(owner.snapshot()).not.toBeNull()
  })

  test("clear when no snapshot exists returns true (already cleared)", () => {
    expect(owner.clear()).toBe(true)
    expect(owner.clear(0)).toBe(true)
  })
})
