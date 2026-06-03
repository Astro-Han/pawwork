import { describe, expect, test } from "bun:test"

import { decidePublishAction } from "./publish-when-complete"
import type { GithubRelease } from "./verify-release"

const BUILD_SHA = "1111111111111111111111111111111111111111"

// A complete release payload: every installer + updater sidecar + the two
// channel files present, matching releaseAssetNames("2026.6.1").
const completeRelease: GithubRelease = {
  tag_name: "v2026.6.1",
  draft: true,
  prerelease: false,
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
  decidePublishAction({ release: completeRelease, latestYml, latestMacYml, buildSha: BUILD_SHA, ...overrides })

describe("decidePublishAction", () => {
  test("publishes a complete draft and pins it to the build commit", () => {
    expect(decide().kind).toBe("publish")
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

  test("refuses to publish when the existing tag points at another commit", () => {
    const decision = decide({ existingTagSha: "2222222222222222222222222222222222222222" })
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("refusing to publish mismatched sources")
  })

  test("publishes when the tag already exists at the same build commit", () => {
    expect(decide({ existingTagSha: BUILD_SHA }).kind).toBe("publish")
  })
})
