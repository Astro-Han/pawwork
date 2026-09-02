import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { decideDraftAction } from "./ensure-release-draft"
import { fetchReleasesByTag, type GithubRelease } from "./verify-release"

// Shaped like the /releases payload the guard filters by tag, trimmed to the
// fields the decision reads.
const release = (id: number, tag: string, draft = true): GithubRelease & { id: number } => ({
  id,
  tag_name: tag,
  draft,
  prerelease: false,
  assets: [],
})

// A full first page of unrelated releases, so the tag only appears on page two.
const pagedReleases = (matchOnPage2: Array<GithubRelease & { id: number }>) => {
  const first = Array.from({ length: 100 }, (_, index) => release(9000 + index, `v2025.1.${index + 1}`, false))
  return async (url: string) => (new URL(url).searchParams.get("page") === "1" ? first : matchOnPage2)
}

describe("ensure-release-draft", () => {
  test("creates a draft when the tag has no release", () => {
    expect(decideDraftAction("v2026.6.1", [])).toEqual({
      kind: "create",
      reason: expect.stringContaining("no release for v2026.6.1"),
    })
  })

  test("reuses the tag's only draft", () => {
    expect(decideDraftAction("v2026.6.1", [release(1, "v2026.6.1")])).toEqual({
      kind: "reuse",
      published: false,
      reason: expect.stringContaining("reusing draft 1"),
    })
  })

  // Uploading into a release that is already live is legitimate on a re-run but
  // is not what the caller assumes, so it is flagged rather than logged plain.
  test("flags an already published release as a warning-worthy reuse", () => {
    expect(decideDraftAction("v2026.6.1", [release(1, "v2026.6.1", false)])).toEqual({
      kind: "reuse",
      published: true,
      reason: expect.stringContaining("already published"),
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
    expect(decision.reason).toContain("keep the one holding the assets")
  })

  // A match missed because it sat past the first page reads as "no release for
  // this tag", which is exactly the state that creates a duplicate.
  test("reuses a release that only appears on a later page of the list", async () => {
    const matches = await fetchReleasesByTag(
      "Astro-Han/pawwork",
      "v2026.6.1",
      pagedReleases([release(7, "v2026.6.1")]),
    )
    expect(matches.map((match) => match.id)).toEqual([7])
    expect(decideDraftAction("v2026.6.1", matches)).toEqual({
      kind: "reuse",
      published: false,
      reason: expect.stringContaining("reusing draft 7"),
    })
  })

  // The create is only half the guard: reading the list endpoint back too soon
  // can miss a concurrent job's release, and both would conclude they are alone.
  test("jitters before creating and lets the list endpoint settle before judging", () => {
    const source = readFileSync(join(import.meta.dirname, "ensure-release-draft.ts"), "utf8")
    expect(source).toMatch(/await sleep\(Math\.random\(\) \* CREATE_JITTER_MS\)/)
    expect(source).toMatch(/await sleep\(CREATE_SETTLE_MS\)\n\n\s*const settled =/)
    // A missing token silently downgrades the list to anonymous, which cannot
    // see drafts at all.
    expect(source).toMatch(/requireEnv\("GH_TOKEN"\)/)
  })
})
