import { afterEach, describe, expect, test } from "vitest"

import {
  fetchJson,
  fetchText,
  normalizeTag,
  parseUpdaterFileUrls,
  parseUpdaterShaByUrl,
  releaseAssetNames,
  releaseUpdaterAssetNames,
  verifyReleasePayload,
  type GithubRelease,
} from "./verify-release"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})
const baseRelease: GithubRelease = {
  tag_name: "v2026.4.28",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "pawwork-mac-arm64-2026.4.28.dmg",
      browser_download_url: "https://example.com/pawwork-mac-arm64-2026.4.28.dmg",
    },
    {
      name: "pawwork-mac-arm64-2026.4.28.zip",
      browser_download_url: "https://example.com/pawwork-mac-arm64-2026.4.28.zip",
    },
    {
      name: "pawwork-mac-arm64-2026.4.28.zip.blockmap",
      browser_download_url: "https://example.com/pawwork-mac-arm64-2026.4.28.zip.blockmap",
    },
    {
      name: "pawwork-mac-x64-2026.4.28.dmg",
      browser_download_url: "https://example.com/pawwork-mac-x64-2026.4.28.dmg",
    },
    {
      name: "pawwork-mac-x64-2026.4.28.zip",
      browser_download_url: "https://example.com/pawwork-mac-x64-2026.4.28.zip",
    },
    {
      name: "pawwork-mac-x64-2026.4.28.zip.blockmap",
      browser_download_url: "https://example.com/pawwork-mac-x64-2026.4.28.zip.blockmap",
    },
    {
      name: "pawwork-win-x64-2026.4.28.exe",
      browser_download_url: "https://example.com/pawwork-win-x64-2026.4.28.exe",
    },
    {
      name: "pawwork-win-x64-2026.4.28.exe.blockmap",
      browser_download_url: "https://example.com/pawwork-win-x64-2026.4.28.exe.blockmap",
    },
    {
      name: "latest.yml",
      browser_download_url: "https://example.com/latest.yml",
    },
    {
      name: "latest-mac.yml",
      browser_download_url: "https://example.com/latest-mac.yml",
    },
  ],
}

const validLatestYml = "version: 2026.4.28\nfiles:\n  - url: pawwork-win-x64-2026.4.28.exe\n"
const validLatestMacYml =
  "version: 2026.4.28\nfiles:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n"

describe("verify-release", () => {
  test("normalizes release tags", () => {
    expect(normalizeTag("2026.4.28")).toBe("v2026.4.28")
    expect(normalizeTag("v2026.4.28")).toBe("v2026.4.28")
    expect(() => normalizeTag("vv2026.4.28")).toThrow("Invalid release tag")
    expect(() => normalizeTag("")).toThrow("Invalid release tag")
    expect(() => normalizeTag("v")).toThrow("Invalid release tag")
    expect(() => normalizeTag("abc")).toThrow("Invalid release tag")
    expect(() => normalizeTag("2026.4.28.1")).toThrow("Invalid release tag")
    expect(() => normalizeTag("2026.4.28-hotfix.1")).toThrow("Invalid release tag")
  })

  test("derives release and updater asset names from the CalVer version", () => {
    expect(releaseAssetNames("2026.4.28")).toEqual([
      "pawwork-mac-arm64-2026.4.28.dmg",
      "pawwork-mac-arm64-2026.4.28.zip",
      "pawwork-mac-arm64-2026.4.28.zip.blockmap",
      "pawwork-mac-x64-2026.4.28.dmg",
      "pawwork-mac-x64-2026.4.28.zip",
      "pawwork-mac-x64-2026.4.28.zip.blockmap",
      "pawwork-win-x64-2026.4.28.exe",
      "pawwork-win-x64-2026.4.28.exe.blockmap",
      "latest.yml",
      "latest-mac.yml",
    ])
    expect(releaseUpdaterAssetNames("2026.4.28")).toEqual({
      "latest.yml": ["pawwork-win-x64-2026.4.28.exe"],
      "latest-mac.yml": ["pawwork-mac-arm64-2026.4.28.zip", "pawwork-mac-x64-2026.4.28.zip"],
    })
  })

  test("parses updater file urls and path entries", () => {
    expect(
      parseUpdaterFileUrls(`version: 2026.4.28
files:
  - url: pawwork-mac-arm64-2026.4.28.zip
    size: 1
  - url: pawwork-mac-x64-2026.4.28.zip
    size: 2
path: pawwork-mac-arm64-2026.4.28.zip
`),
    ).toEqual(["pawwork-mac-arm64-2026.4.28.zip", "pawwork-mac-x64-2026.4.28.zip", "pawwork-mac-arm64-2026.4.28.zip"])
  })

  test("parses quoted updater file urls and path entries", () => {
    expect(
      parseUpdaterFileUrls(`files:
  - url: "pawwork-mac-arm64-2026.4.28.zip"
  - url: 'pawwork-mac-x64-2026.4.28.zip' # Intel macOS updater asset
  - url: "pawwork-mac#arm64.zip"
    path: "pawwork-win-x64-2026.4.28.exe" # Windows updater asset
`),
    ).toEqual([
      "pawwork-mac-arm64-2026.4.28.zip",
      "pawwork-mac-x64-2026.4.28.zip",
      "pawwork-mac#arm64.zip",
      "pawwork-win-x64-2026.4.28.exe",
    ])
  })

  test("keeps inline comments outside escaped quoted values", () => {
    expect(
      parseUpdaterFileUrls(String.raw`files:
  - url: "pawwork-mac\"arm64.zip" # comment
  - url: "pawwork-mac\\"
path: pawwork-win-x64-2026.4.28.exe
`),
    ).toEqual([String.raw`pawwork-mac\"arm64.zip`, String.raw`pawwork-mac\\`, "pawwork-win-x64-2026.4.28.exe"])
  })

  test("accepts a stable release with expected assets and updater metadata", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: validLatestYml,
        latestMacYml: validLatestMacYml,
      }),
    ).toEqual([])
  })

  test("rejects updater metadata without a top-level version", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: validLatestMacYml,
    })

    expect(failures).toContain("latest.yml does not declare version 2026.4.28")
  })

  test("rejects updater metadata for a different release version", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "version: 2026.4.27\nfiles:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: validLatestMacYml,
    })

    expect(failures).toContain("latest.yml version 2026.4.27 does not match release 2026.4.28")
  })

  test("accepts updater metadata entries with full download URLs", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml:
          "version: 2026.4.28\nfiles:\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v2026.4.28/pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml:
          "version: 2026.4.28\nfiles:\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v2026.4.28/pawwork-mac-arm64-2026.4.28.zip\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v2026.4.28/pawwork-mac-x64-2026.4.28.zip\n",
      }),
    ).toEqual([])
  })

  test("reports missing macOS updater architecture metadata", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: validLatestYml,
        latestMacYml: "files:\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      }),
    ).toContain("latest-mac.yml does not include pawwork-mac-arm64-2026.4.28.zip")
  })

  test("reports updater metadata that points to a missing asset", () => {
    expect(
      verifyReleasePayload({
        release: {
          ...baseRelease,
          assets: baseRelease.assets.filter((asset) => asset.name !== "pawwork-mac-arm64-2026.4.28.zip"),
        },
        latestYml: validLatestYml,
        latestMacYml: validLatestMacYml,
      }),
    ).toContain("latest-mac.yml references missing release asset: pawwork-mac-arm64-2026.4.28.zip")
  })

  test("reports missing installer and updater sidecar assets", () => {
    const failures = verifyReleasePayload({
      release: {
        ...baseRelease,
        assets: baseRelease.assets.filter(
          (asset) =>
            asset.name !== "pawwork-mac-arm64-2026.4.28.dmg" && asset.name !== "pawwork-win-x64-2026.4.28.exe.blockmap",
        ),
      },
      latestYml: validLatestYml,
      latestMacYml: validLatestMacYml,
    })

    expect(failures).toContain("Missing release asset: pawwork-mac-arm64-2026.4.28.dmg")
    expect(failures).toContain("Missing release asset: pawwork-win-x64-2026.4.28.exe.blockmap")
  })

  test("reports missing updater metadata assets without requiring metadata downloads", () => {
    const failures = verifyReleasePayload({
      release: {
        ...baseRelease,
        assets: baseRelease.assets.filter((asset) => asset.name !== "latest.yml" && asset.name !== "latest-mac.yml"),
      },
      latestYml: "",
      latestMacYml: "",
    })

    expect(failures).toContain("Missing release asset: latest.yml")
    expect(failures).toContain("Missing release asset: latest-mac.yml")
    expect(failures).toContain("latest.yml does not include pawwork-win-x64-2026.4.28.exe")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-arm64-2026.4.28.zip")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-x64-2026.4.28.zip")
  })

  test("reports draft releases", () => {
    expect(
      verifyReleasePayload({
        release: { ...baseRelease, draft: true },
        latestYml: validLatestYml,
        latestMacYml: validLatestMacYml,
      }),
    ).toContain("Release v2026.4.28 is still a draft")
  })

  test("allowDraft suppresses the draft failure but keeps every other check", () => {
    const latestYml = validLatestYml
    const latestMacYml = validLatestMacYml

    // A complete draft is fully accepted when drafts are allowed.
    expect(
      verifyReleasePayload({ release: { ...baseRelease, draft: true }, latestYml, latestMacYml }, { allowDraft: true }),
    ).toEqual([])

    // allowDraft does not loosen anything else: missing assets still fail.
    const failures = verifyReleasePayload(
      {
        release: {
          ...baseRelease,
          draft: true,
          assets: baseRelease.assets.filter((asset) => asset.name !== "pawwork-mac-arm64-2026.4.28.dmg"),
        },
        latestYml,
        latestMacYml,
      },
      { allowDraft: true },
    )
    expect(failures).toContain("Missing release asset: pawwork-mac-arm64-2026.4.28.dmg")
    expect(failures).not.toContain("Release v2026.4.28 is still a draft")
  })

  test("reports prerelease releases", () => {
    expect(
      verifyReleasePayload({
        release: { ...baseRelease, prerelease: true },
        latestYml: validLatestYml,
        latestMacYml: validLatestMacYml,
      }),
    ).toContain("Release v2026.4.28 is marked as a prerelease")
  })

  test("reports malformed updater metadata as missing required updater entries", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - broken: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - broken: pawwork-mac-arm64-2026.4.28.zip\n",
    })

    expect(failures).toContain("latest.yml does not include pawwork-win-x64-2026.4.28.exe")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-arm64-2026.4.28.zip")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-x64-2026.4.28.zip")
  })

  test("reports invalid release tags in release payloads without throwing", () => {
    expect(
      verifyReleasePayload({
        release: { ...baseRelease, tag_name: "v2026.4.28.1" },
        latestYml: "",
        latestMacYml: "",
      }),
    ).toEqual(["Invalid release tag: v2026.4.28.1. Expected vYYYY.M.D or YYYY.M.D."])
  })

  test("fetchText reports GitHub rate limit headers on HTTP errors", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("rate limited", {
          status: 403,
          statusText: "Forbidden",
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1234567890",
          },
        }),
      )) as typeof fetch

    await expect(fetchText("https://api.github.com/example")).rejects.toThrow("rate limit remaining: 0")
  })

  test("fetchText reports network failures with the request URL", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("socket hang up"))) as typeof fetch

    await expect(fetchText("https://api.github.com/example")).rejects.toThrow(
      "Failed to fetch https://api.github.com/example: socket hang up",
    )
  })

  test("fetchJson reports invalid JSON with the request URL", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch

    await expect(fetchJson("https://api.github.com/example")).rejects.toThrow(
      "Failed to parse JSON from https://api.github.com/example",
    )
  })
})

describe("parseUpdaterShaByUrl", () => {
  test("pairs each updater file with its content sha512, keyed by asset basename", () => {
    const yml = [
      "version: 2026.6.1",
      "files:",
      "  - url: pawwork-mac-arm64-2026.6.1.zip",
      "    sha512: HASH_ARM64",
      "    size: 123",
      "  - url: pawwork-mac-x64-2026.6.1.zip",
      "    sha512: HASH_X64",
      "    size: 456",
      "path: pawwork-mac-arm64-2026.6.1.zip",
      "sha512: HASH_ARM64",
      "releaseDate: '2026-06-01T00:00:00.000Z'",
    ].join("\n")

    expect(parseUpdaterShaByUrl(yml)).toEqual([
      { name: "pawwork-mac-arm64-2026.6.1.zip", sha512: "HASH_ARM64" },
      { name: "pawwork-mac-x64-2026.6.1.zip", sha512: "HASH_X64" },
    ])
  })

  test("reduces a full download URL to its basename and ignores the trailing path digest", () => {
    const yml = [
      "files:",
      "  - url: https://example.com/download/pawwork-win-x64-2026.6.1.exe",
      "    sha512: HASH_WIN",
      "path: pawwork-win-x64-2026.6.1.exe",
      "sha512: HASH_WIN",
    ].join("\n")

    // The top-level `sha512:` after `path:` has no preceding `- url:` entry, so it
    // is not emitted as a phantom hash.
    expect(parseUpdaterShaByUrl(yml)).toEqual([{ name: "pawwork-win-x64-2026.6.1.exe", sha512: "HASH_WIN" }])
  })
})
