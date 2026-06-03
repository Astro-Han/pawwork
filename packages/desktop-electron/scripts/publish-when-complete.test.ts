import { describe, expect, test } from "bun:test"

import { decidePublishAction, recordedBuildSha } from "./publish-when-complete"
import type { GithubRelease } from "./verify-release"

const BUILD_SHA = "1111111111111111111111111111111111111111"
const OTHER_SHA = "2222222222222222222222222222222222222222"

// A complete release payload: every installer + updater sidecar + the two
// channel files present, matching releaseAssetNames("2026.6.1").
const completeRelease: GithubRelease = {
  tag_name: "v2026.6.1",
  draft: true,
  prerelease: false,
  target_commitish: BUILD_SHA,
  assets: [
    "pawwork-mac-arm64-2026.6.1.dmg",
    "pawwork-mac-arm64-2026.6.1.zip",
    "pawwork-mac-arm64-2026.6.1.zip.blockmap",
    "pawwork-mac-x64-2026.6.1.dmg",
    "pawwork-mac-x64-2026.6.1.zip",
    "pawwork-mac-x64-2026.6.1.zip.blockmap",
    "pawwork-win-x64-2026.6.1.exe",
    "pawwork-win-x64-2026.6.1.exe.blockmap",
    "latest.yml",
    "latest-mac.yml",
  ].map((name) => ({ name, browser_download_url: `https://example.com/${name}` })),
}

const latestYml = "files:\n  - url: pawwork-win-x64-2026.6.1.exe\n"
const latestMacYml = "files:\n  - url: pawwork-mac-arm64-2026.6.1.zip\n  - url: pawwork-mac-x64-2026.6.1.zip\n"

const decide = (overrides: Partial<Parameters<typeof decidePublishAction>[0]> = {}) =>
  decidePublishAction({
    release: completeRelease,
    latestYml,
    latestMacYml,
    buildSha: BUILD_SHA,
    recordedSha: BUILD_SHA,
    ...overrides,
  })

describe("decidePublishAction", () => {
  test("publishes a complete, single-source draft and pins it to the build commit", () => {
    expect(decide().kind).toBe("publish")
  })

  test("publishes when the draft is not yet claimed (first target)", () => {
    expect(decide({ recordedSha: undefined }).kind).toBe("publish")
  })

  test("waits when a target's assets have not landed yet", () => {
    const partial: GithubRelease = {
      ...completeRelease,
      assets: completeRelease.assets.filter((asset) => asset.name !== "pawwork-win-x64-2026.6.1.exe"),
    }
    const decision = decide({ release: partial })
    expect(decision.kind).toBe("wait")
    expect(decision.reason).toContain("pawwork-win-x64-2026.6.1.exe")
  })

  test("waits when the updater metadata asset is not uploaded yet", () => {
    // latest.yml exists as an asset but has not been fetched (a missing target);
    // the metadata cross-check must fail, keeping us in wait rather than publish.
    const decision = decide({ latestYml: undefined })
    expect(decision.kind).toBe("wait")
  })

  test("only mirrors when the release is already published (no re-publish)", () => {
    expect(decide({ release: { ...completeRelease, draft: false } }).kind).toBe("mirror-only")
  })

  test("fails loudly on a prerelease instead of waiting forever", () => {
    const decision = decide({ release: { ...completeRelease, prerelease: true } })
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("prerelease")
  })

  test("refuses to publish when the draft was claimed by a different build commit", () => {
    const decision = decide({ recordedSha: OTHER_SHA })
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("mixed-source release")
  })

  test("provenance mismatch beats completeness: fails even on an incomplete draft", () => {
    const partial: GithubRelease = {
      ...completeRelease,
      assets: completeRelease.assets.filter((asset) => asset.name !== "pawwork-win-x64-2026.6.1.exe"),
    }
    // A divergent source is fatal regardless of how complete the draft is, so we
    // never reach the wait branch.
    expect(decide({ release: partial, recordedSha: OTHER_SHA }).kind).toBe("fail")
  })
})

describe("recordedBuildSha", () => {
  test("returns the commit when target_commitish is a full SHA", () => {
    expect(recordedBuildSha({ ...completeRelease, target_commitish: BUILD_SHA })).toBe(BUILD_SHA)
  })

  test("treats a branch name as unclaimed", () => {
    expect(recordedBuildSha({ ...completeRelease, target_commitish: "dev" })).toBeUndefined()
  })

  test("treats a missing target_commitish as unclaimed", () => {
    expect(recordedBuildSha({ ...completeRelease, target_commitish: undefined })).toBeUndefined()
  })
})
