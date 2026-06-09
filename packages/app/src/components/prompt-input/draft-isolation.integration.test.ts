/**
 * Integration tests for homepage draft ownership across workspaces.
 *
 * The homepage composer keeps one global draft while the workspace route
 * remains the send target. Ordinary homepage drafts are not owner-backed;
 * pinned deep-link prefill remains a directory-bound owner.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createPortableDraftOwner } from "./portable-draft"
import { createPinnedDraftOwner } from "./pinned-draft"
import { buildRequestParts } from "./build-request-parts"
import { captureCommentMentions } from "./mention-metadata"
import { detectSubmitOwnership } from "./submit-ownership"
import { toAbsoluteFilePath } from "./path-canonical"

beforeAll(() => {
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
})

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

describe("homepage draft ownership invariants", () => {
  let portable: ReturnType<typeof createPortableDraftOwner>
  let pinned: ReturnType<typeof createPinnedDraftOwner>

  beforeEach(() => {
    portable = createPortableDraftOwner()
    pinned = createPinnedDraftOwner()
  })

  test("ordinary homepage drafts are route-owned even when a portable migration snapshot exists", () => {
    portable.record({ sourceFilesystemDirectory: "/A", ...payload("migrated once") })

    const ownershipOnA = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      sourceFilesystemDirectory: "/A",
      routeScope: ROUTE_SCOPE_A,
    })
    const ownershipOnB = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      sourceFilesystemDirectory: "/B",
      routeScope: ROUTE_SCOPE_B,
    })

    expect(ownershipOnA).toEqual({ kind: "route", scope: ROUTE_SCOPE_A })
    expect(ownershipOnB).toEqual({ kind: "route", scope: ROUTE_SCOPE_B })
  })

  test("pinned slot beats ordinary route ownership only for its bound directory", () => {
    pinned.adopt({ directory: "/A", prompt: "pinned content" })

    const ownershipOnA = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      sourceFilesystemDirectory: "/A",
      routeScope: ROUTE_SCOPE_A,
    })
    const ownershipOnB = detectSubmitOwnership({
      isHomepage: true,
      pinned,
      sourceFilesystemDirectory: "/B",
      routeScope: ROUTE_SCOPE_B,
    })

    expect(ownershipOnA.kind).toBe("pinned")
    expect(ownershipOnB).toEqual({ kind: "route", scope: ROUTE_SCOPE_B })
  })

  test("context path selected in A stays anchored to A when the global draft is submitted from B", () => {
    const contextPath = toAbsoluteFilePath("/repo-A", "src/app.ts")

    const result = buildRequestParts({
      prompt: payload("look at this").prompt,
      context: [{ key: "ctx:1", type: "file", path: contextPath }],
      images: [],
      text: "look at this",
      messageID: "msg_global",
      sessionID: "ses_global",
      sessionDirectory: "/repo-B",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo-A/src/app.ts")).toBe(true)
    expect(files.every((part) => !(part.type === "file" && part.url.startsWith("file:///repo-B/src/app")))).toBe(true)
  })

  test("comment @mention captured in A stays anchored to A when submitted from B", () => {
    const comment = "compare with @src/shared.ts"
    const resolvedMentions = captureCommentMentions({ comment, sourceFilesystemDirectory: "/repo-A" })

    const result = buildRequestParts({
      prompt: payload("review").prompt,
      context: [
        {
          key: "ctx:c1",
          type: "file",
          path: toAbsoluteFilePath("/repo-A", "src/main.ts"),
          comment,
          commentID: "c1",
          resolvedMentions,
        },
      ],
      images: [],
      text: "review",
      messageID: "msg_global_mention",
      sessionID: "ses_global_mention",
      sessionDirectory: "/repo-B",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo-A/src/shared.ts")).toBe(true)
    expect(files.every((part) => !(part.type === "file" && part.url.startsWith("file:///repo-B/src/shared")))).toBe(true)
  })
})
