/**
 * Integration-style tests for v7 portable homepage owner semantics,
 * exercised via the shim re-export from draft-carryover.ts.
 */

import { describe, expect, test } from "bun:test"
import { createPortableDraftOwner } from "./portable-draft"
import type { PortableDraftPayload } from "./portable-draft"

function makePayload(text: string): PortableDraftPayload {
  return {
    prompt: [{ type: "text", content: text, start: 0, end: text.length }],
    context: [],
    images: [],
    resolvedMentions: {},
  }
}

describe("portable homepage owner — integration scenarios", () => {
  test("homepage A → homepage B: snapshot moves", () => {
    const owner = createPortableDraftOwner()
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("draft text") })
    expect(owner.snapshot()?.sourceFilesystemDirectory).toBe("/a")

    // Navigate to empty homepage B — snapshot moves
    const moved = owner.consumeForHomepage("/b", true)
    expect(moved).not.toBeNull()
    expect(moved?.sourceFilesystemDirectory).toBe("/b")
    expect(moved?.revision).toBeGreaterThan(1) // bumped on move
    expect(owner.snapshot()?.sourceFilesystemDirectory).toBe("/b")
  })

  test("homepage A → homepage A: no self-consume", () => {
    const owner = createPortableDraftOwner()
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("draft text") })
    const result = owner.consumeForHomepage("/a", true)
    expect(result).toBeNull()
    // Snapshot still exists
    expect(owner.snapshot()).not.toBeNull()
  })

  test("homepage A → homepage B when B already has draft: no overwrite", () => {
    const owner = createPortableDraftOwner()
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("draft text") })
    // B is NOT empty (targetIsEmpty = false)
    const result = owner.consumeForHomepage("/b", false)
    expect(result).toBeNull()
    // Snapshot still anchored to A
    expect(owner.snapshot()?.sourceFilesystemDirectory).toBe("/a")
  })

  test("record with empty payload clears", () => {
    const owner = createPortableDraftOwner()
    owner.record({ sourceFilesystemDirectory: "/a", ...makePayload("draft text") })
    expect(owner.snapshot()).not.toBeNull()

    // Record empty content
    owner.record({
      sourceFilesystemDirectory: "/a",
      prompt: [{ type: "text", content: "", start: 0, end: 0 }],
      context: [],
      images: [],
      resolvedMentions: {},
    })
    expect(owner.snapshot()).toBeNull()
  })
})
