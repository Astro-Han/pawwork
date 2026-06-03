import { describe, expect, test } from "bun:test"

import { decidePublishAction, type ProvenanceMarker } from "./publish-when-complete"
import { releaseProvenanceAssetNames, type GithubRelease } from "./verify-release"

const BUILD_SHA = "1111111111111111111111111111111111111111"
const OTHER_SHA = "2222222222222222222222222222222222222222"

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

const expectedProvenance = releaseProvenanceAssetNames("2026.6.1")

// One distinct installer hash per target, recorded both in that target's marker
// and in the updater metadata, so the content anchor holds when nothing drifted.
const shaFor = (markerName: string) => `sha-${markerName}`
const allAgree: Record<string, ProvenanceMarker> = Object.fromEntries(
  expectedProvenance.map((name) => [name, { commit: BUILD_SHA, sha512: [shaFor(name)] }]),
)
const updaterSha512s = expectedProvenance.map(shaFor)

const decide = (overrides: Partial<Parameters<typeof decidePublishAction>[0]> = {}) =>
  decidePublishAction({
    release: completeRelease,
    latestYml,
    latestMacYml,
    buildSha: BUILD_SHA,
    provenance: allAgree,
    expectedProvenance,
    updaterSha512s,
    ...overrides,
  })

describe("releaseProvenanceAssetNames", () => {
  test("derives one .commit marker per release target", () => {
    expect(releaseProvenanceAssetNames("2026.6.1")).toEqual([
      "pawwork-mac-arm64-2026.6.1.commit",
      "pawwork-mac-x64-2026.6.1.commit",
      "pawwork-win-x64-2026.6.1.commit",
    ])
  })
})

describe("decidePublishAction", () => {
  test("publishes a complete release when every marker agrees and matches the metadata", () => {
    expect(decide().kind).toBe("publish")
  })

  test("waits when a target's installer has not landed yet", () => {
    const partial: GithubRelease = {
      ...completeRelease,
      assets: completeRelease.assets.filter((asset) => asset.name !== "pawwork-win-x64-2026.6.1.exe"),
    }
    const decision = decide({ release: partial })
    expect(decision.kind).toBe("wait")
    expect(decision.reason).toContain("pawwork-win-x64-2026.6.1.exe")
  })

  test("waits when the updater metadata asset is not uploaded yet", () => {
    expect(decide({ latestYml: undefined }).kind).toBe("wait")
  })

  test("waits when a target has not uploaded its provenance marker yet", () => {
    const { "pawwork-win-x64-2026.6.1.commit": _omit, ...rest } = allAgree
    const decision = decide({ provenance: rest })
    expect(decision.kind).toBe("wait")
    expect(decision.reason).toContain("pawwork-win-x64-2026.6.1.commit")
  })

  test("only mirrors when the release is already published (no re-publish)", () => {
    expect(decide({ release: { ...completeRelease, draft: false } }).kind).toBe("mirror-only")
  })

  test("fails loudly on a prerelease instead of waiting forever", () => {
    const decision = decide({ release: { ...completeRelease, prerelease: true } })
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("prerelease")
  })

  test("refuses to publish when a marker disagrees on the build commit", () => {
    const decision = decide({
      provenance: { ...allAgree, "pawwork-win-x64-2026.6.1.commit": { commit: OTHER_SHA, sha512: ["sha-win"] } },
    })
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("mixed-source release")
  })

  test("provenance mismatch beats completeness: fails even on an incomplete draft", () => {
    const partial: GithubRelease = {
      ...completeRelease,
      assets: completeRelease.assets.filter((asset) => asset.name !== "pawwork-win-x64-2026.6.1.exe"),
    }
    // Two targets built from different commits never converge to "all agree":
    // the mismatch is fatal regardless of how complete the draft looks, so the
    // race where a last writer could publish a mixed release cannot occur.
    expect(
      decide({
        release: partial,
        provenance: { ...allAgree, "pawwork-mac-x64-2026.6.1.commit": { commit: OTHER_SHA, sha512: ["sha-x64"] } },
      }).kind,
    ).toBe("fail")
  })

  test("content anchor: refuses when a marker's installer hash drifted out of the metadata", () => {
    // A target rebuilt from another commit (same version, agreeing commit field
    // by accident) produces a different installer hash; that hash is no longer in
    // latest*.yml, so the content anchor catches a clobber the commit field misses.
    const drifted: Record<string, ProvenanceMarker> = {
      ...allAgree,
      "pawwork-win-x64-2026.6.1.commit": { commit: BUILD_SHA, sha512: ["sha-rebuilt-from-another-commit"] },
    }
    const decision = decide({ provenance: drifted })
    expect(decision.kind).toBe("fail")
    expect(decision.reason).toContain("no longer matches recorded build hashes")
  })

  test("content anchor tolerates an empty-hash marker (metadata read hiccup at marker time)", () => {
    // A target that could not read its own updater entry when writing the marker
    // records an empty hash list. That target simply isn't content-anchored; the
    // commit-agreement + completeness gates still apply, so the release is not
    // deadlocked into a permanent draft over a transient read miss.
    const noHash: Record<string, ProvenanceMarker> = {
      ...allAgree,
      "pawwork-win-x64-2026.6.1.commit": { commit: BUILD_SHA, sha512: [] },
    }
    expect(decide({ provenance: noHash }).kind).toBe("publish")
  })
})
