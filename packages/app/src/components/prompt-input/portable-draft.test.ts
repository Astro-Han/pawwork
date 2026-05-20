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

  test("bumps revision when image attachment list changes", () => {
    const base = makePayload("hello")
    owner.record({ sourceFilesystemDirectory: "/a", ...base })
    expect(owner.snapshot()?.revision).toBe(1)
    owner.record({
      sourceFilesystemDirectory: "/a",
      ...base,
      images: [{ type: "image", id: "img2", filename: "b.png", mime: "image/png", dataUrl: "data:b" }],
    })
    expect(owner.snapshot()?.revision).toBe(2)
  })

  test("does not bump revision when context items are reordered identically", () => {
    // Same content in same order => no bump (JSON.stringify order-sensitive)
    const base = makePayload("hello")
    const ctx = [
      { type: "file" as const, path: "/a/x.ts", key: "file:/a/x.ts:undefined:undefined" },
      { type: "file" as const, path: "/a/y.ts", key: "file:/a/y.ts:undefined:undefined" },
    ]
    owner.record({ sourceFilesystemDirectory: "/a", ...base, context: ctx })
    expect(owner.snapshot()?.revision).toBe(1)
    // Same items in same order — revision must not bump.
    owner.record({ sourceFilesystemDirectory: "/a", ...base, context: [...ctx] })
    expect(owner.snapshot()?.revision).toBe(1)
    // Reversed order is treated as different (JSON.stringify is order-sensitive).
    owner.record({ sourceFilesystemDirectory: "/a", ...base, context: [...ctx].reverse() })
    expect(owner.snapshot()?.revision).toBe(2)
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

describe("PortableDraftOwner consumption hydrates context items", () => {
  let owner: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    owner = createPortableDraftOwner()
  })

  test("consumeForHomepage returns the full payload including context, images, resolvedMentions", () => {
    const contextItems = [
      {
        type: "file" as const,
        path: "/a/foo.ts",
        key: "file:/a/foo.ts:undefined:undefined",
        comment: "check this",
        commentID: "cmt-1",
      },
    ]
    const images = [{ type: "image" as const, id: "img1", filename: "a.png", mime: "image/png", dataUrl: "data:a" }]
    const resolvedMentions = {
      "file:/a/foo.ts:undefined:undefined:c=cmt-1": [
        { displayText: "@foo.ts", resolvedPath: "/a/foo.ts", fingerprint: "f1", start: 0, end: 7 },
      ],
    }

    owner.record({
      sourceFilesystemDirectory: "/a",
      prompt: [{ type: "text", content: "check this", start: 0, end: 10 }],
      context: contextItems,
      images,
      resolvedMentions,
    })

    const snap = owner.consumeForHomepage("/b", true)
    expect(snap).not.toBeNull()
    // Full payload must be present in the returned snapshot.
    expect(snap?.context).toEqual(contextItems)
    expect(snap?.images).toEqual(images)
    expect(snap?.resolvedMentions).toEqual(resolvedMentions)
    // sourceFilesystemDirectory must be updated to target.
    expect(snap?.sourceFilesystemDirectory).toBe("/b")
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

describe("PortableDraftOwner canonicalizes file paths against the source directory", () => {
  let owner: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    owner = createPortableDraftOwner()
  })

  test("record rewrites relative context file paths to absolute", () => {
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: DEFAULT_PROMPT,
      context: [{ key: "k1", type: "file", path: "src/app.ts" }],
      images: [],
      resolvedMentions: {},
    })
    expect(owner.snapshot()?.context[0]?.path).toBe("/repo-A/src/app.ts")
  })

  test("record rewrites relative prompt file parts to absolute", () => {
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: [
        { type: "text", content: "see ", start: 0, end: 4 },
        { type: "file", content: "@src/app.ts", path: "src/app.ts", start: 4, end: 15 },
      ],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    const filePart = owner.snapshot()?.prompt.find((p) => p.type === "file")
    expect(filePart && "path" in filePart ? filePart.path : undefined).toBe("/repo-A/src/app.ts")
  })

  test("record leaves already-absolute paths untouched", () => {
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: DEFAULT_PROMPT,
      context: [{ key: "k1", type: "file", path: "/home/elsewhere/file.ts" }],
      images: [],
      resolvedMentions: {},
    })
    expect(owner.snapshot()?.context[0]?.path).toBe("/home/elsewhere/file.ts")
  })

  test("A→B carry preserves the source workspace's absolute path", () => {
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: DEFAULT_PROMPT,
      context: [{ key: "k1", type: "file", path: "src/app.ts" }],
      images: [],
      resolvedMentions: {},
    })
    const moved = owner.consumeForHomepage("/repo-B", true)
    expect(moved?.sourceFilesystemDirectory).toBe("/repo-B")
    // Path stays anchored to /repo-A — this is the whole point of canonicalization
    expect(moved?.context[0]?.path).toBe("/repo-A/src/app.ts")
  })
})

// ---------------------------------------------------------------------------
// Marked TextPart (command pill) round-trip through the owner.
//
// Path A/B/C all produce a Prompt whose leading TextPart carries a `command`
// field. The homepage owner mirror effect records that Prompt verbatim; on
// route-back hydration, the snapshot is replayed via prompt.set(snapshot.prompt).
// This test pins that the `command` metadata survives intact through the
// owner — otherwise the user's pill would silently degrade to raw slash text
// after a route change.
// ---------------------------------------------------------------------------

describe("PortableDraftOwner preserves command metadata on marked TextPart", () => {
  test("snapshot retains command field after record", () => {
    const owner = createPortableDraftOwner()
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: [{
        type: "text",
        content: "/brainstorming hello",
        start: 0,
        end: 20,
        command: { name: "brainstorming", source: "skill", icon: "command" },
      }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    const snap = owner.snapshot()
    expect(snap).not.toBeNull()
    const first = snap!.prompt[0]
    expect(first?.type).toBe("text")
    expect((first as any).command).toEqual({
      name: "brainstorming",
      source: "skill",
      icon: "command",
    })
    expect((first as any).content).toBe("/brainstorming hello")
  })

  test("regression guard: empty payload destroys an existing non-empty snapshot", () => {
    // record() short-circuits empty payloads to setSnapshot(null). If the
    // editor-input.ts homepage owner mirror effect ever fires at mount with
    // DEFAULT_PROMPT (empty), this is what would happen to a portable
    // snapshot from another homepage that hasn't been consumed yet —
    // silently destroying the user's draft before hydration can move it.
    // The mirror effect's {defer: true} option is what prevents this.
    const owner = createPortableDraftOwner()
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: [{
        type: "text",
        content: "/brainstorming the failing test",
        start: 0,
        end: 31,
        command: { name: "brainstorming", source: "skill", icon: "command" },
      }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    expect(owner.snapshot()).not.toBeNull()

    // Empty payload — the shape the prompt has at mount.
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    expect(owner.snapshot()).toBeNull()
  })

  test("consumeForHomepage round-trip preserves command field", () => {
    const owner = createPortableDraftOwner()
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: [{
        type: "text",
        content: "/review HEAD~3",
        start: 0,
        end: 14,
        command: { name: "review", source: "command", icon: "command" },
      }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    // Same-dir homepage navigation: snapshot restored via restore(), not consumed.
    const restored = owner.restore()
    expect((restored!.prompt[0] as any).command?.name).toBe("review")
    // Different-dir move via consumeForHomepage: command still preserved.
    const moved = owner.consumeForHomepage("/repo-B", true)
    expect((moved!.prompt[0] as any).command?.name).toBe("review")
    expect((moved!.prompt[0] as any).content).toBe("/review HEAD~3")
  })
})
