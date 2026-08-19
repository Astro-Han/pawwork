import { describe, expect, test } from "bun:test"
import path from "node:path"

import manifest from "../bundled-tools.json"
import {
  assetForTarget,
  binaryNameForPlatform,
  companionBinaryNameForPlatform,
  pinnedSha256ForTarget,
  powershellExpandArchiveArgs,
  runtimeBinaryPath,
  sha256,
  uvDownloadUrl,
  uvTargetFor,
  uvVersionMatches,
} from "./prepare-uv"

describe("prepare-uv manifest helpers", () => {
  test("maps supported targets to upstream uv release assets", () => {
    expect(assetForTarget("darwin", "arm64")).toBe("uv-aarch64-apple-darwin.tar.gz")
    expect(assetForTarget("darwin", "x64")).toBe("uv-x86_64-apple-darwin.tar.gz")
    expect(assetForTarget("win32", "x64")).toBe("uv-x86_64-pc-windows-msvc.zip")
  })

  test("rejects unsupported targets", () => {
    expect(() => assetForTarget("linux" as any, "x64")).toThrow("Unsupported uv target: linux-x64")
  })

  test("returns supported targets with narrowed platform and arch", () => {
    expect(uvTargetFor("darwin", "arm64")).toEqual({ platform: "darwin", arch: "arm64" })
    expect(uvTargetFor("win32", "x64")).toEqual({ platform: "win32", arch: "x64" })
    expect(uvTargetFor("linux", "x64")).toBeNull()
  })

  test("pins a lowercase 64-hex sha256 in the repo manifest for every supported target", () => {
    // The pinned hash is the verification authority: prepare-uv.ts must never
    // fall back to a checksum file fetched from the release being verified.
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["win32", "x64"],
    ] as const) {
      const pinned = pinnedSha256ForTarget(platform, arch)
      expect(pinned).toMatch(/^[a-f0-9]{64}$/)
      expect(pinned).toBe(manifest.uv.assets[`${platform}-${arch}`].sha256.toLowerCase())
    }
  })

  test("pins distinct hashes per asset (no copy-paste placeholder)", () => {
    const hashes = (["darwin-arm64", "darwin-x64", "win32-x64"] as const).map(
      (key) => manifest.uv.assets[key].sha256,
    )
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  test("uses platform runtime binary names", () => {
    expect(binaryNameForPlatform("darwin")).toBe("uv")
    expect(binaryNameForPlatform("win32")).toBe("uv.exe")
    expect(companionBinaryNameForPlatform("darwin")).toBe("uvx")
    expect(companionBinaryNameForPlatform("win32")).toBe("uvx.exe")
  })

  test("builds pinned release URLs and does not use latest", () => {
    const url = uvDownloadUrl("0.11.28", "uv-x86_64-pc-windows-msvc.zip")
    expect(url).toBe("https://github.com/astral-sh/uv/releases/download/0.11.28/uv-x86_64-pc-windows-msvc.zip")
    expect(url).not.toContain("/latest/")
  })

  test("hashes bytes to lowercase hex sha256", () => {
    expect(sha256(new TextEncoder().encode("hello").buffer)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    )
  })

  test("matches the exact uv version token", () => {
    expect(uvVersionMatches("uv 0.11.28 (ebf0f43d7 2026-07-07)\n", "0.11.28")).toBe(true)
    expect(uvVersionMatches("uv 0.11.280 (ebf0f43d7 2026-07-07)\n", "0.11.28")).toBe(false)
  })

  test("resolves runtime binary paths under the tools directory", () => {
    expect(runtimeBinaryPath("/repo/packages/desktop-electron/resources/tools", "win32")).toBe(
      path.join("/repo/packages/desktop-electron/resources/tools", "uv.exe"),
    )
  })

  test("escapes apostrophes in Windows paths used as PowerShell literals", () => {
    const archive = "C:\\Users\\O'Brien\\uv.zip"
    const destination = "C:\\Users\\O'Brien\\extract"
    const args = powershellExpandArchiveArgs(archive, destination)

    expect(args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath 'C:\\Users\\O''Brien\\uv.zip' -DestinationPath 'C:\\Users\\O''Brien\\extract' -Force",
    ])
  })
})
