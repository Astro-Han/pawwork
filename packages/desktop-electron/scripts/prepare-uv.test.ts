import { describe, expect, test } from "bun:test"
import path from "node:path"

import {
  assetForTarget,
  binaryNameForPlatform,
  companionBinaryNameForPlatform,
  parseSha256Sum,
  runtimeBinaryPath,
  sha256,
  uvDownloadUrl,
  uvSha256SumUrl,
  uvTargetFor,
  uvVersionMatches,
} from "./prepare-uv"

describe("prepare-uv manifest helpers", () => {
  test("maps supported targets to upstream uv release assets", () => {
    expect(assetForTarget("darwin", "arm64")).toBe("uv-aarch64-apple-darwin.tar.gz")
    expect(assetForTarget("darwin", "x64")).toBe("uv-x86_64-apple-darwin.tar.gz")
    expect(assetForTarget("win32", "x64")).toBe("uv-x86_64-pc-windows-msvc.zip")
    expect(assetForTarget("win32", "arm64")).toBe("uv-aarch64-pc-windows-msvc.zip")
  })

  test("rejects unsupported targets", () => {
    expect(() => assetForTarget("linux" as any, "x64")).toThrow("Unsupported uv target: linux-x64")
  })

  test("returns supported targets with narrowed platform and arch", () => {
    expect(uvTargetFor("darwin", "arm64")).toEqual({ platform: "darwin", arch: "arm64" })
    expect(uvTargetFor("win32", "x64")).toEqual({ platform: "win32", arch: "x64" })
    expect(uvTargetFor("linux", "x64")).toBeNull()
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
    expect(uvSha256SumUrl("0.11.28")).toBe("https://github.com/astral-sh/uv/releases/download/0.11.28/sha256.sum")
  })

  test("parses sha256.sum entries by asset name (with and without the leading asterisk)", () => {
    const parsed = parseSha256Sum(
      "3a3444224a4a017cd94f4a8471abbd03647d42c2b9a1b9f78102bccab344af67 *source.tar.gz\n" +
        "33540EB7C883AB857EFF79BD5AC2AA31FE27B595ABECB4A9C003A2C998447232  uv-aarch64-apple-darwin.tar.gz\n",
    )
    expect(parsed.get("uv-aarch64-apple-darwin.tar.gz")).toBe(
      "33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232",
    )
    expect(parsed.get("source.tar.gz")).toBe("3a3444224a4a017cd94f4a8471abbd03647d42c2b9a1b9f78102bccab344af67")
  })

  test("ignores malformed sha256.sum lines", () => {
    expect(parseSha256Sum("not-a-sum  uv\n").size).toBe(0)
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
})
