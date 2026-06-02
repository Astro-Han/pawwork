import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createPortableDraftOwner } from "./portable-draft"
import { createPinnedDraftOwner } from "./pinned-draft"
import { detectSubmitOwnership, type SubmitOwnership } from "./submit-ownership"

beforeAll(() => {
  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
    checksum: (value: string) => String(value.length),
    sampledChecksum: (value: string) => String(value.length),
  }))
})

const ROUTE_SCOPE = { dir: "L3JlcG8vbWFpbg", id: undefined } as const

function nonEmptyPayload(text: string) {
  return {
    prompt: [{ type: "text" as const, content: text, start: 0, end: text.length }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

describe("detectSubmitOwnership", () => {
  let portable: ReturnType<typeof createPortableDraftOwner>
  let pinned: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    portable = createPortableDraftOwner()
    pinned = createPinnedDraftOwner()
  })

  test("returns route when on a concrete session (isHomepage=false)", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("hello") })
    pinned.adopt({ directory: "/repo/main", prompt: "hi" })
    const result = detectSubmitOwnership({
      isHomepage: false,
      pinned,
      portable,
      sourceFilesystemDirectory: "/repo/main",
      routeScope: ROUTE_SCOPE,
    })
    expect(result.kind).toBe("route")
    if (result.kind === "route") {
      expect(result.scope).toEqual(ROUTE_SCOPE)
    }
  })

  test("returns portable when on homepage and portable matches directory", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("hello") })
    const snapAtCapture = portable.snapshot()
    const result = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/repo/main",
      routeScope: ROUTE_SCOPE,
    })
    expect(result.kind).toBe("portable")
    if (result.kind === "portable") {
      expect(result.revision).toBe(snapAtCapture!.revision)
      expect(result.sourceFilesystemDirectory).toBe("/repo/main")
    }
  })

  test("returns pinned when on homepage and pinned matches directory (pinned beats portable)", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("portable") })
    pinned.adopt({ directory: "/repo/main", prompt: "deep-link" })
    const pinnedAtCapture = pinned.current()
    const result = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/repo/main",
      routeScope: ROUTE_SCOPE,
    })
    expect(result.kind).toBe("pinned")
    if (result.kind === "pinned") {
      expect(result.revision).toBe(pinnedAtCapture!.revision)
      expect(result.directory).toBe("/repo/main")
    }
  })

  test("returns route when on homepage but neither owner matches directory", () => {
    // Portable snapshot bound to a DIFFERENT directory should not be claimed.
    portable.record({ sourceFilesystemDirectory: "/repo/other", ...nonEmptyPayload("elsewhere") })
    const result = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/repo/main",
      routeScope: ROUTE_SCOPE,
    })
    expect(result.kind).toBe("route")
  })

  test("returns route when on homepage and both owners are empty", () => {
    const result = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/repo/main",
      routeScope: ROUTE_SCOPE,
    })
    expect(result.kind).toBe("route")
  })

  test("captured ownership is a snapshot value, not a live reference", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("v1") })
    const result: SubmitOwnership = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/repo/main",
      routeScope: ROUTE_SCOPE,
    })
    const capturedRevision = result.kind === "portable" ? result.revision : -1
    // Simulate user typing during the submit's await.
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("v2") })
    // Captured revision is frozen and now diverges from the live owner.
    expect(portable.snapshot()!.revision).not.toBe(capturedRevision)
    expect(capturedRevision).toBeGreaterThan(0)
  })
})

describe("revision-guarded clear and restore", () => {
  let portable: ReturnType<typeof createPortableDraftOwner>
  let pinned: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    portable = createPortableDraftOwner()
    pinned = createPinnedDraftOwner()
  })

  test("portable.clear returns true and empties owner when revision matches", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("hello") })
    const captured = portable.snapshot()!.revision
    const cleared = portable.clear(captured)
    expect(cleared).toBe(true)
    expect(portable.snapshot()).toBeNull()
  })

  test("portable.clear returns false and leaves owner when revision diverged", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("hello") })
    const captured = portable.snapshot()!.revision
    // User types new content during the submit await.
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("typed-new") })
    const cleared = portable.clear(captured)
    expect(cleared).toBe(false)
    expect(portable.snapshot()).not.toBeNull()
    expect(portable.snapshot()!.prompt[0]).toMatchObject({ content: "typed-new" })
  })

  test("pinned.clearAll returns true and releases slot when revision matches", () => {
    pinned.adopt({ directory: "/repo/main", prompt: "deep-link" })
    const captured = pinned.current()!.revision
    const cleared = pinned.clearAll(captured)
    expect(cleared).toBe(true)
    expect(pinned.current()).toBeNull()
  })

  test("pinned.clearAll returns false and preserves slot when revision diverged", () => {
    pinned.adopt({ directory: "/repo/main", prompt: "deep-link" })
    const captured = pinned.current()!.revision
    // User types during await.
    pinned.recordEdit({
      directory: "/repo/main",
      prompt: [{ type: "text", content: "typed-new", start: 0, end: 9 }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    const cleared = pinned.clearAll(captured)
    expect(cleared).toBe(false)
    expect(pinned.current()).not.toBeNull()
    expect(pinned.current()!.prompt[0]).toMatchObject({ content: "typed-new" })
  })

  test("portable revision moves monotonically across record/clear cycles", () => {
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("v1") })
    const r1 = portable.snapshot()!.revision
    portable.record({ sourceFilesystemDirectory: "/repo/main", ...nonEmptyPayload("v2") })
    const r2 = portable.snapshot()!.revision
    expect(r2).toBeGreaterThan(r1)
  })
})
