import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { releaseAssetNames } from "./verify-release.ts"
import {
  buildManifest,
  missingPointerReferences,
  pointerReferencedAssets,
  uploadPlan,
} from "./mirror-release-to-r2.ts"

describe("buildManifest", () => {
  test("locks the manifest shape and per-platform installer URLs", () => {
    expect(buildManifest("2026.5.29", "https://dl.pawwork.ai")).toEqual({
      version: "2026.5.29",
      macArm64: "https://dl.pawwork.ai/pawwork-mac-arm64-2026.5.29.dmg",
      macX64: "https://dl.pawwork.ai/pawwork-mac-x64-2026.5.29.dmg",
      winX64: "https://dl.pawwork.ai/pawwork-win-x64-2026.5.29.exe",
    })
  })

  test("normalizes a trailing slash in the public base", () => {
    expect(buildManifest("2026.5.29", "https://dl.pawwork.ai/").macArm64).toBe(
      "https://dl.pawwork.ai/pawwork-mac-arm64-2026.5.29.dmg",
    )
  })
})

describe("uploadPlan", () => {
  const plan = uploadPlan(releaseAssetNames("2026.5.29"))
  const names = plan.map((step) => step.name)

  test("ends with the landing-page manifest as the single live switch", () => {
    expect(names.at(-1)).toBe("latest.json")
    expect(plan.at(-1)).toMatchObject({ manifest: true, cacheControl: "no-cache, must-revalidate" })
  })

  test("orders immutable versioned artifacts before the mutable updater pointers", () => {
    const lastVersioned = Math.max(
      names.indexOf("pawwork-mac-arm64-2026.5.29.dmg"),
      names.indexOf("pawwork-win-x64-2026.5.29.exe"),
      names.indexOf("pawwork-mac-arm64-2026.5.29.zip.blockmap"),
    )
    const firstPointer = Math.min(names.indexOf("latest.yml"), names.indexOf("latest-mac.yml"))
    expect(lastVersioned).toBeLessThan(firstPointer)
    expect(firstPointer).toBeLessThan(names.indexOf("latest.json"))
  })

  test("marks versioned artifacts immutable and pointers no-cache", () => {
    const cacheOf = (name: string) => plan.find((step) => step.name === name)?.cacheControl
    expect(cacheOf("pawwork-mac-arm64-2026.5.29.dmg")).toBe("public, max-age=31536000, immutable")
    expect(cacheOf("latest.yml")).toBe("no-cache, must-revalidate")
    expect(cacheOf("latest-mac.yml")).toBe("no-cache, must-revalidate")
  })

  test("uploads every released asset exactly once plus the manifest", () => {
    const assets = releaseAssetNames("2026.5.29")
    expect(names.slice(0, -1).sort()).toEqual([...assets].sort())
    expect(new Set(names).size).toBe(names.length)
  })
})

describe("pointer reference alignment", () => {
  const latestMacYml = [
    "version: 2026.5.29",
    "files:",
    "  - url: pawwork-mac-arm64-2026.5.29.zip",
    "    sha512: abc",
    "    size: 123",
    "  - url: pawwork-mac-x64-2026.5.29.zip",
    "    sha512: def",
    "    size: 456",
    "path: pawwork-mac-arm64-2026.5.29.zip",
    "sha512: abc",
    "",
  ].join("\n")

  test("collects the deduped asset names a pointer references", () => {
    expect(pointerReferencedAssets(latestMacYml)).toEqual([
      "pawwork-mac-arm64-2026.5.29.zip",
      "pawwork-mac-x64-2026.5.29.zip",
    ])
  })

  test("reduces a full download URL to its asset name", () => {
    const yml = "files:\n  - url: https://example.com/d/pawwork-win-x64-2026.5.29.exe\npath: pawwork-win-x64-2026.5.29.exe\n"
    expect(pointerReferencedAssets(yml)).toEqual(["pawwork-win-x64-2026.5.29.exe"])
  })

  test("flags references the mirror would not upload", () => {
    const mirrored = new Set(releaseAssetNames("2026.5.29"))
    expect(missingPointerReferences(pointerReferencedAssets(latestMacYml), mirrored)).toEqual([])
    expect(missingPointerReferences(["pawwork-mac-arm64-9.9.9.zip"], mirrored)).toEqual([
      "pawwork-mac-arm64-9.9.9.zip",
    ])
  })
})

describe("mirror workflow shell-injection guard", () => {
  const workflow = readFileSync(
    join(import.meta.dir, "..", "..", "..", ".github", "workflows", "mirror-release-to-r2.yml"),
    "utf8",
  )

  test("never interpolates a GitHub expression into a run: command", () => {
    // An attacker-controlled tag must reach the secrets-bearing steps as data
    // ($TAG), never as shell text — ${{ }} in a run: line allows injection.
    const offending = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => line.includes("run:") && line.includes("${{"))
    expect(offending).toEqual([])
  })

  test("passes the tag to scripts via the quoted env var", () => {
    expect(workflow).toContain('verify-release.ts "$TAG"')
    expect(workflow).toContain('mirror-release-to-r2.ts "$TAG"')
  })
})
