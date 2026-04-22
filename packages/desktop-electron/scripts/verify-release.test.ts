import { afterEach, describe, expect, test } from "bun:test"

import {
  fetchJson,
  fetchText,
  normalizeTag,
  parseUpdaterFileUrls,
  verifyReleasePayload,
  type GithubRelease,
} from "./verify-release"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const baseRelease: GithubRelease = {
  tag_name: "v0.2.6",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "pawwork-mac-arm64.dmg",
      browser_download_url: "https://example.com/pawwork-mac-arm64.dmg",
    },
    {
      name: "pawwork-mac-arm64.zip",
      browser_download_url: "https://example.com/pawwork-mac-arm64.zip",
    },
    {
      name: "pawwork-mac-arm64.zip.blockmap",
      browser_download_url: "https://example.com/pawwork-mac-arm64.zip.blockmap",
    },
    {
      name: "pawwork-mac-x64.dmg",
      browser_download_url: "https://example.com/pawwork-mac-x64.dmg",
    },
    {
      name: "pawwork-mac-x64.zip",
      browser_download_url: "https://example.com/pawwork-mac-x64.zip",
    },
    {
      name: "pawwork-mac-x64.zip.blockmap",
      browser_download_url: "https://example.com/pawwork-mac-x64.zip.blockmap",
    },
    {
      name: "pawwork-win-x64.exe",
      browser_download_url: "https://example.com/pawwork-win-x64.exe",
    },
    {
      name: "pawwork-win-x64.exe.blockmap",
      browser_download_url: "https://example.com/pawwork-win-x64.exe.blockmap",
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

describe("verify-release", () => {
  test("normalizes release tags", () => {
    expect(normalizeTag("0.2.6")).toBe("v0.2.6")
    expect(normalizeTag("v0.2.6")).toBe("v0.2.6")
    expect(() => normalizeTag("vv0.2.6")).toThrow("Invalid release tag")
    expect(() => normalizeTag("abc")).toThrow("Invalid release tag")
  })

  test("parses updater file urls and path entries", () => {
    expect(
      parseUpdaterFileUrls(`version: 0.2.6
files:
  - url: pawwork-mac-arm64.zip
    size: 1
  - url: pawwork-mac-x64.zip
    size: 2
path: pawwork-mac-arm64.zip
`),
    ).toEqual(["pawwork-mac-arm64.zip", "pawwork-mac-x64.zip", "pawwork-mac-arm64.zip"])
  })

  test("parses quoted updater file urls and path entries", () => {
    expect(
      parseUpdaterFileUrls(`files:
  - url: "pawwork-mac-arm64.zip"
  - url: 'pawwork-mac-x64.zip' # Intel macOS updater asset
  - url: "pawwork-mac#arm64.zip"
    path: "pawwork-win-x64.exe" # Windows updater asset
`),
    ).toEqual(["pawwork-mac-arm64.zip", "pawwork-mac-x64.zip", "pawwork-mac#arm64.zip", "pawwork-win-x64.exe"])
  })

  test("keeps inline comments outside escaped quoted values", () => {
    expect(
      parseUpdaterFileUrls(String.raw`files:
  - url: "pawwork-mac\"arm64.zip" # comment
  - url: "pawwork-mac\\"
path: pawwork-win-x64.exe
`),
    ).toEqual([String.raw`pawwork-mac\"arm64.zip`, String.raw`pawwork-mac\\`, "pawwork-win-x64.exe"])
  })

  test("accepts a stable release with expected assets and updater metadata", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: "files:\n  - url: pawwork-win-x64.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64.zip\n  - url: pawwork-mac-x64.zip\n",
      }),
    ).toEqual([])
  })

  test("accepts updater metadata entries with full download URLs", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: "files:\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v0.2.6/pawwork-win-x64.exe\n",
        latestMacYml:
          "files:\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v0.2.6/pawwork-mac-arm64.zip\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v0.2.6/pawwork-mac-x64.zip\n",
      }),
    ).toEqual([])
  })

  test("reports missing macOS updater architecture metadata", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: "files:\n  - url: pawwork-win-x64.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-x64.zip\n",
      }),
    ).toContain("latest-mac.yml does not include pawwork-mac-arm64.zip")
  })

  test("reports updater metadata that points to a missing asset", () => {
    expect(
      verifyReleasePayload({
        release: {
          ...baseRelease,
          assets: baseRelease.assets.filter((asset) => asset.name !== "pawwork-mac-arm64.zip"),
        },
        latestYml: "files:\n  - url: pawwork-win-x64.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64.zip\n  - url: pawwork-mac-x64.zip\n",
      }),
    ).toContain("latest-mac.yml references missing release asset: pawwork-mac-arm64.zip")
  })

  test("reports missing installer and updater sidecar assets", () => {
    const failures = verifyReleasePayload({
      release: {
        ...baseRelease,
        assets: baseRelease.assets.filter(
          (asset) => asset.name !== "pawwork-mac-arm64.dmg" && asset.name !== "pawwork-win-x64.exe.blockmap",
        ),
      },
      latestYml: "files:\n  - url: pawwork-win-x64.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64.zip\n  - url: pawwork-mac-x64.zip\n",
    })

    expect(failures).toContain("Missing release asset: pawwork-mac-arm64.dmg")
    expect(failures).toContain("Missing release asset: pawwork-win-x64.exe.blockmap")
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
    expect(failures).toContain("latest.yml does not include pawwork-win-x64.exe")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-arm64.zip")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-x64.zip")
  })

  test("reports draft releases", () => {
    expect(
      verifyReleasePayload({
        release: { ...baseRelease, draft: true },
        latestYml: "files:\n  - url: pawwork-win-x64.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64.zip\n  - url: pawwork-mac-x64.zip\n",
      }),
    ).toContain("Release v0.2.6 is still a draft")
  })

  test("reports prerelease releases", () => {
    expect(
      verifyReleasePayload({
        release: { ...baseRelease, prerelease: true },
        latestYml: "files:\n  - url: pawwork-win-x64.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64.zip\n  - url: pawwork-mac-x64.zip\n",
      }),
    ).toContain("Release v0.2.6 is marked as a prerelease")
  })

  test("reports malformed updater metadata as missing required updater entries", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - broken: pawwork-win-x64.exe\n",
      latestMacYml: "files:\n  - broken: pawwork-mac-arm64.zip\n",
    })

    expect(failures).toContain("latest.yml does not include pawwork-win-x64.exe")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-arm64.zip")
    expect(failures).toContain("latest-mac.yml does not include pawwork-mac-x64.zip")
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
