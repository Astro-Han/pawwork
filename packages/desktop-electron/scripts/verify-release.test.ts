import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  escapeRegExp,
  fetchJson,
  fetchText,
  normalizeTag,
  parseUpdaterFileUrls,
  readStartupLogFile,
  releaseAssetNames,
  releaseUpdaterAssetNames,
  verifyReleasePayload,
  verifyStartupLog,
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
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      }),
    ).toEqual([])
  })

  test("accepts updater metadata entries with full download URLs", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml:
          "files:\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v2026.4.28/pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml:
          "files:\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v2026.4.28/pawwork-mac-arm64-2026.4.28.zip\n  - url: https://github.com/Astro-Han/pawwork/releases/download/v2026.4.28/pawwork-mac-x64-2026.4.28.zip\n",
      }),
    ).toEqual([])
  })

  test("reports missing macOS updater architecture metadata", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
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
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
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
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
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
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      }),
    ).toContain("Release v2026.4.28 is still a draft")
  })

  test("reports prerelease releases", () => {
    expect(
      verifyReleasePayload({
        release: { ...baseRelease, prerelease: true },
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
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

  test("accepts a complete startup log for the release version", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
        startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init done
`,
      }),
    ).toEqual([])
  })

  test("reports an empty startup log", () => {
    expect(
      verifyReleasePayload({
        release: baseRelease,
        latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
        latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
        startupLog: "",
      }),
    ).toEqual(["Latest startup log does not include any app starting entry"])
  })

  test("reports a fresh startup log stuck after sidecar readiness", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:16.300] [info]  spawning sidecar { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:16.767] [info]  sidecar connection started { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.129] [info]  awaiting server ready
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
`,
    })

    expect(failures).toContain("Latest startup log does not include loading task finished")
    expect(failures).toContain("Latest startup log does not include init step done")
    expect(failures).toHaveLength(2)
  })

  test("does not accept awaiting server ready as server ready", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:18.129] [info]  awaiting server ready
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init done
`,
    })

    expect(failures).toEqual(["Latest startup log does not include server ready"])
  })

  test("checks the latest startup attempt instead of an older successful launch", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 20:00:00.000] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 20:00:01.000] [info]  loading task finished
[2026-04-22 20:00:01.001] [info]  init done
[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:16.767] [info]  sidecar connection started { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
`,
    })

    expect(failures).toContain("Latest startup log does not include loading task finished")
    expect(failures).toContain("Latest startup log does not include init step done")
    expect(failures).toHaveLength(2)
  })

  test("reports release version mismatches in the startup log", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '0.2.5', packaged: true }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init done
`,
    })

    expect(failures).toContain("Latest startup log version does not match expected 2026.4.28")
  })

  test("reports startup logs from unpackaged desktop runs", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: false }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init done
`,
    })

    expect(failures).toEqual(["Latest startup log does not include packaged true"])
  })

  test("reports invalid release tags during startup log verification", () => {
    expect(
      verifyStartupLog(
        `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init done
`,
        "v",
      ),
    ).toEqual(["Invalid release tag: v. Expected vYYYY.M.D or YYYY.M.D."])
  })

  test("reports invalid release tags with other startup failures", () => {
    expect(
      verifyStartupLog(
        `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
`,
        "v",
      ),
    ).toEqual([
      "Invalid release tag: v. Expected vYYYY.M.D or YYYY.M.D.",
      "Latest startup log does not include server ready",
      "Latest startup log does not include loading task finished",
      "Latest startup log does not include init step done",
    ])
  })

  test("does not accept 'phase: done' in a non-init-step log line", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init step { step: { phase: 'loading' } }
[2026-04-22 21:26:18.132] [info]  unrelated message containing phase: 'done'
`,
    })

    expect(failures).toContain("Latest startup log does not include init step done")
  })

  test("does not accept legacy init step done without the dedicated marker", () => {
    const failures = verifyReleasePayload({
      release: baseRelease,
      latestYml: "files:\n  - url: pawwork-win-x64-2026.4.28.exe\n",
      latestMacYml: "files:\n  - url: pawwork-mac-arm64-2026.4.28.zip\n  - url: pawwork-mac-x64-2026.4.28.zip\n",
      startupLog: `[2026-04-22 21:26:16.088] [info]  app starting { version: '2026.4.28', packaged: true }
[2026-04-22 21:26:18.129] [info]  server ready { url: 'http://127.0.0.1:59635' }
[2026-04-22 21:26:18.130] [info]  loading task finished
[2026-04-22 21:26:18.131] [info]  init step { step: { phase: 'done' } }
`,
    })

    expect(failures).toContain("Latest startup log does not include init step done")
  })

  test("reads startup log files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawwork-release-log-"))
    const logPath = join(dir, "main.log")

    try {
      await writeFile(logPath, "startup log contents", "utf8")
      await expect(readStartupLogFile(logPath)).resolves.toBe("startup log contents")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports unreadable startup log files with the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pawwork-release-log-"))
    const missingPath = join(dir, "missing-main.log")

    try {
      await expect(readStartupLogFile(missingPath)).rejects.toThrow(
        new RegExp(`^Failed to read startup log file ${escapeRegExp(missingPath)}: .+`),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
