import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_PROMPT } from "@/context/prompt-equality"
import { createPortableDraftOwner, type PortableDraftPayload } from "./portable-draft"

function makePayload(text: string): PortableDraftPayload {
  return {
    prompt: [{ type: "text", content: text, start: 0, end: text.length }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

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

  test("creates a migration snapshot with revision 1 on first record", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    const snap = owner.snapshot()
    expect(snap).not.toBeNull()
    expect(snap?.revision).toBe(1)
    expect(snap?.sourceFilesystemDirectory).toBe("/a")
  })

  test("does not bump revision when payload and source dir are unchanged", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.snapshot()?.revision).toBe(1)
  })

  test("bumps revision when payload changes", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("world") })
    expect(owner.snapshot()?.revision).toBe(2)
  })

  test("clears snapshot when payload becomes empty", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    owner.record({ sourceFilesystemDirectory: "/a", ...emptyPayload() })
    expect(owner.snapshot()).toBeNull()
  })

  test("canonicalizes relative context and prompt file paths against the source directory", () => {
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: [
        { type: "text", content: "see ", start: 0, end: 4 },
        { type: "file", content: "@src/app.ts", path: "src/app.ts", start: 4, end: 15 },
      ],
      context: [{ key: "k1", type: "file", path: "src/app.ts" }],
      images: [],
      resolvedMentions: {},
    })

    const filePart = owner.snapshot()?.prompt.find((part) => part.type === "file")
    expect(filePart && "path" in filePart ? filePart.path : undefined).toBe("/repo-A/src/app.ts")
    expect(owner.snapshot()?.context[0]?.path).toBe("/repo-A/src/app.ts")
  })

  test("leaves already absolute paths untouched", () => {
    owner.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: DEFAULT_PROMPT,
      context: [{ key: "k1", type: "file", path: "/home/elsewhere/file.ts" }],
      images: [],
      resolvedMentions: {},
    })
    expect(owner.snapshot()?.context[0]?.path).toBe("/home/elsewhere/file.ts")
  })
})

describe("PortableDraftOwner.restore", () => {
  test("returns the migration snapshot without moving it between directories", () => {
    const owner = createPortableDraftOwner()
    owner.record({ sourceFilesystemDirectory: "/repo-A", ...makePayload("migrate me") })

    const restored = owner.restore()

    expect(restored?.sourceFilesystemDirectory).toBe("/repo-A")
    expect(restored?.prompt[0]).toMatchObject({ content: "migrate me" })
    expect(owner.snapshot()?.sourceFilesystemDirectory).toBe("/repo-A")
  })
})

describe("PortableDraftOwner.clear", () => {
  let owner: ReturnType<typeof createPortableDraftOwner>

  beforeEach(() => {
    owner = createPortableDraftOwner()
  })

  test("clear without expectedRevision clears the snapshot", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.clear()).toBe(true)
    expect(owner.snapshot()).toBeNull()
  })

  test("clear with matching expectedRevision clears", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.clear(owner.revision())).toBe(true)
    expect(owner.snapshot()).toBeNull()
  })

  test("clear with stale expectedRevision does not clear", () => {
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("hello") })
    expect(owner.clear(999)).toBe(false)
    expect(owner.snapshot()).not.toBeNull()
  })

  test("clear when no snapshot exists returns true when already clear", () => {
    expect(owner.clear()).toBe(true)
    expect(owner.clear(0)).toBe(true)
  })
})

describe("PortableDraftOwner preserves command metadata", () => {
  test("snapshot retains command field after record and restore", () => {
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

    const first = owner.restore()!.prompt[0]
    expect(first?.type).toBe("text")
    expect(first && "command" in first ? first.command : undefined).toEqual({
      name: "review",
      source: "command",
      icon: "command",
    })
  })
})
