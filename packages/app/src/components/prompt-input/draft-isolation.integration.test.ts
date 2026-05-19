/**
 * Integration tests for cross-workspace draft isolation (PR #750 v7, T10).
 *
 * These tests exercise the full owner-chain contract that individual unit tests
 * cover in isolation: portable carry (A→B), detectSubmitOwnership binding,
 * and the stale-revision guard on clear/clearAll.
 *
 * Each test is a "slice" through multiple owner calls so that regressions in
 * the hand-off between owners are caught here even if isolated unit tests pass.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createPortableDraftOwner } from "./portable-draft"
import { createPinnedDraftOwner } from "./pinned-draft"
import { buildRequestParts } from "./build-request-parts"
import { captureCommentMentions } from "./mention-metadata"

let detectSubmitOwnership: typeof import("./submit").detectSubmitOwnership

beforeAll(async () => {
  // submit.ts pulls in router/sdk/etc. at module scope; mock bare minimum.
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  // Use a real FNV-1a checksum so that Persist.workspace() still produces
  // distinct storage names for different directories (the string-length mock
  // used in submit-ownership.test.ts is order-dependent and leaks into
  // history-navigation.test.ts when files run together).
  const fnv1a = (value: string): string | undefined => {
    if (!value) return undefined
    let h = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(36)
  }
  mock.module("@opencode-ai/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
    checksum: fnv1a,
    sampledChecksum: fnv1a,
  }))
  const mod = await import("./submit")
  detectSubmitOwnership = mod.detectSubmitOwnership
})

// Minimal non-empty payload for a given text string.
function payload(text: string) {
  return {
    prompt: [{ type: "text" as const, content: text, start: 0, end: text.length }],
    context: [] as [],
    images: [] as [],
    resolvedMentions: {} as Record<string, never[]>,
  }
}

const ROUTE_SCOPE_A = { dir: "L0E", id: undefined } as const
const ROUTE_SCOPE_B = { dir: "L0F", id: undefined } as const

describe("draft isolation invariants (cross-owner chain)", () => {
  let portable: ReturnType<typeof createPortableDraftOwner>
  let pinned: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    portable = createPortableDraftOwner()
    pinned = createPinnedDraftOwner()
  })

  // ------------------------------------------------------------------
  // Core regression: cross-workspace portable carry
  // ------------------------------------------------------------------

  test("portable draft moves from /A to /B and is bound to /B afterward", () => {
    // User types on homepage /A, then navigates to homepage /B (empty).
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("workspace A text") })
    expect(portable.snapshot()?.sourceFilesystemDirectory).toBe("/A")

    const moved = portable.consumeForHomepage("/B", true)
    // consumeForHomepage returns the moved snapshot.
    expect(moved).not.toBeNull()
    expect(moved?.prompt[0]).toMatchObject({ content: "workspace A text" })
    // After the move, the internal snapshot is anchored to /B, not /A.
    expect(portable.snapshot()?.sourceFilesystemDirectory).toBe("/B")
  })

  test("portable draft moved to /B is NOT detected as owned by /A (cross-workspace isolation)", () => {
    // A draft from /A travels to /B.
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("workspace A text") })
    portable.consumeForHomepage("/B", true)

    // Back on homepage /A: the snapshot is now anchored to /B, so /A gets "route".
    const ownershipOnA = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/A",
      routeScope: ROUTE_SCOPE_A,
    })
    expect(ownershipOnA.kind).toBe("route")
  })

  test("portable draft moved to /B IS detected as owned by /B (content reaches target workspace)", () => {
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("workspace A text") })
    portable.consumeForHomepage("/B", true)

    // On homepage /B: ownership should be portable, bound to /B.
    const ownershipOnB = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/B",
      routeScope: ROUTE_SCOPE_B,
    })
    expect(ownershipOnB.kind).toBe("portable")
    if (ownershipOnB.kind === "portable") {
      expect(ownershipOnB.sourceFilesystemDirectory).toBe("/B")
    }
  })

  test("portable draft is never detected on a session route even after move (session isolation)", () => {
    // Draft travels A→B, but user opens a session on /B instead of staying on homepage.
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("workspace A text") })
    portable.consumeForHomepage("/B", true)

    // isHomepage: false means a concrete session route; ownership must be "route".
    const ownershipOnSession = detectSubmitOwnership({
      isHomepage: false,
      pinned,
      portable,
      sourceFilesystemDirectory: "/B",
      routeScope: { dir: "L0F", id: "ses_42" },
    })
    expect(ownershipOnSession.kind).toBe("route")
  })

  // ------------------------------------------------------------------
  // Pinned beats portable (cross-owner priority)
  // ------------------------------------------------------------------

  test("pinned slot beats portable when both are anchored to the same directory", () => {
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("portable content") })
    pinned.adopt({ directory: "/A", prompt: "pinned content" })

    const ownership = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      portable,
      sourceFilesystemDirectory: "/A",
      routeScope: ROUTE_SCOPE_A,
    })
    expect(ownership.kind).toBe("pinned")
    if (ownership.kind === "pinned") {
      expect(ownership.directory).toBe("/A")
    }
  })

  // ------------------------------------------------------------------
  // Stale-revision guard: delayed-success safety across owners
  // ------------------------------------------------------------------

  test("portable.clear with stale revision is a no-op (user typed more during await)", () => {
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("first") })
    const capturedRev = portable.revision()

    // User types more during the async submit.
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("first PLUS new typing") })

    // Stale clear must not wipe the new content.
    expect(portable.clear(capturedRev)).toBe(false)
    expect(portable.snapshot()?.prompt[0]).toMatchObject({ content: "first PLUS new typing" })
  })

  test("pinned.clearAll with stale revision is a no-op (user typed more during await)", () => {
    pinned.adopt({ directory: "/A", prompt: "initial" })
    const capturedRev = pinned.current()!.revision

    pinned.recordEdit({
      directory: "/A",
      ...payload("user typed more"),
    })

    // Stale clearAll must not release the slot.
    expect(pinned.clearAll(capturedRev)).toBe(false)
    expect(pinned.current()).not.toBeNull()
    expect(pinned.current()!.prompt[0]).toMatchObject({ content: "user typed more" })
  })

  // ------------------------------------------------------------------
  // Path-anchoring across A→B carry (P1 #1 regression guard)
  // ------------------------------------------------------------------

  test("portable carry from A→B: relative context path resolves to A's directory, not B's", () => {
    // Record an A-workspace draft that picks src/app.ts (relative).
    portable.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: payload("look at this").prompt,
      context: [{ key: "ctx:1", type: "file", path: "src/app.ts" }],
      images: [],
      resolvedMentions: {},
    })
    const moved = portable.consumeForHomepage("/repo-B", true)
    expect(moved).not.toBeNull()

    // Submit happens on /repo-B but the carried context must still point to A's file.
    const result = buildRequestParts({
      prompt: moved!.prompt,
      context: moved!.context as { key: string; type: "file"; path: string }[],
      images: [],
      text: "look at this",
      messageID: "msg_carry",
      sessionID: "ses_carry",
      sessionDirectory: "/repo-B",
    })

    const files = result.requestParts.filter((p) => p.type === "file")
    expect(files.some((p) => p.type === "file" && p.url === "file:///repo-A/src/app.ts")).toBe(true)
    expect(files.every((p) => !(p.type === "file" && p.url.startsWith("file:///repo-B/src/app")))).toBe(true)
  })

  test("portable carry from A→B: comment @mention resolves to A even when submitted from B", () => {
    const comment = "compare with @src/shared.ts"
    const resolvedMentions = captureCommentMentions({ comment, sourceFilesystemDirectory: "/repo-A" })

    portable.record({
      sourceFilesystemDirectory: "/repo-A",
      prompt: payload("review").prompt,
      context: [
        {
          key: "ctx:c1",
          type: "file",
          path: "src/main.ts",
          comment,
          commentID: "c1",
          resolvedMentions,
        },
      ],
      images: [],
      resolvedMentions: { "ctx:c1": resolvedMentions },
    })
    const moved = portable.consumeForHomepage("/repo-B", true)!

    const result = buildRequestParts({
      prompt: moved.prompt,
      context: moved.context as { key: string; type: "file"; path: string; comment?: string; resolvedMentions?: typeof resolvedMentions }[],
      images: [],
      text: "review",
      messageID: "msg_carry_mention",
      sessionID: "ses_carry_mention",
      sessionDirectory: "/repo-B",
    })

    const files = result.requestParts.filter((p) => p.type === "file")
    // Comment mention must stay anchored to /repo-A even though submit is on /repo-B
    expect(files.some((p) => p.type === "file" && p.url === "file:///repo-A/src/shared.ts")).toBe(true)
    expect(files.every((p) => !(p.type === "file" && p.url.startsWith("file:///repo-B/src/shared")))).toBe(true)
  })
})
