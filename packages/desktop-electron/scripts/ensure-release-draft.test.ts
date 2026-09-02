import { describe, expect, test } from "vitest"

import { decideDraftAction } from "./ensure-release-draft"
import { type GithubRelease } from "./verify-release"

// Shaped like the /releases payload the guard filters by tag, trimmed to the
// fields the decision reads.
const release = (id: number, tag: string, draft = true): GithubRelease & { id: number } => ({
  id,
  tag_name: tag,
  draft,
  prerelease: false,
  assets: [],
})

describe("ensure-release-draft", () => {
  test("creates a draft when the tag has no release", () => {
    expect(decideDraftAction("v2026.6.1", [])).toEqual({
      kind: "create",
      reason: expect.stringContaining("no release for v2026.6.1"),
    })
  })

  test("reuses the single existing release, draft or published", () => {
    expect(decideDraftAction("v2026.6.1", [release(1, "v2026.6.1")])).toEqual({
      kind: "reuse",
      reason: expect.stringContaining("draft"),
    })
    expect(decideDraftAction("v2026.6.1", [release(1, "v2026.6.1", false)])).toEqual({
      kind: "reuse",
      reason: expect.stringContaining("published"),
    })
  })

  // The observed failure mode: two drafts one second apart, assets split, and a
  // checksum error that pointed nowhere near the cause.
  test("fails on a split tag and names the duplicate drafts", () => {
    const decision = decideDraftAction("v2026.9.1", [release(380293071, "v2026.9.1"), release(380293073, "v2026.9.1")])
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("duplicate drafts for tag v2026.9.1")
    expect(decision.reason).toContain("380293071")
    expect(decision.reason).toContain("380293073")
  })
})
