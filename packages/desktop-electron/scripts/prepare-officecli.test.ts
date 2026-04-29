import { describe, expect, test } from "bun:test"
import path from "node:path"

import {
  assetForTarget,
  binaryNameForPlatform,
  officeCliDownloadUrl,
  officeCliSha256SumsUrl,
  parseSha256Sums,
  runtimeBinaryPath,
} from "./prepare-officecli"

describe("prepare-officecli manifest helpers", () => {
  test("maps supported targets to upstream OfficeCLI assets", () => {
    expect(assetForTarget("darwin", "arm64")).toBe("officecli-mac-arm64")
    expect(assetForTarget("darwin", "x64")).toBe("officecli-mac-x64")
    expect(assetForTarget("win32", "x64")).toBe("officecli-win-x64.exe")
    expect(assetForTarget("win32", "arm64")).toBe("officecli-win-arm64.exe")
  })

  test("rejects unsupported targets", () => {
    expect(() => assetForTarget("linux" as any, "x64")).toThrow("Unsupported OfficeCLI target: linux-x64")
  })

  test("uses platform runtime binary names", () => {
    expect(binaryNameForPlatform("darwin")).toBe("officecli")
    expect(binaryNameForPlatform("win32")).toBe("officecli.exe")
  })

  test("builds pinned release URLs and does not use latest", () => {
    const url = officeCliDownloadUrl("v1.0.63", "officecli-win-x64.exe")
    expect(url).toBe("https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.63/officecli-win-x64.exe")
    expect(url).not.toContain("/latest/")
    expect(officeCliSha256SumsUrl("v1.0.63")).toBe(
      "https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.63/SHA256SUMS",
    )
  })

  test("parses SHA256SUMS entries by asset name", () => {
    expect(
      parseSha256Sums(
        "3ede6c3457f050f2d06d95895d7a3391183911ad729c61df990d4e27c1067510  officecli-mac-arm64\nB687396B3A44C6A6AAB7A1A3D9D2325E38D9E7D7F8BF632C2EB2D2B8A9C4872C *officecli-win-x64.exe\n",
      ).get("officecli-win-x64.exe"),
    ).toBe("b687396b3a44c6a6aab7a1a3d9d2325e38d9e7d7f8bf632c2eb2d2b8a9c4872c")
  })

  test("ignores malformed SHA256SUMS lines", () => {
    expect(parseSha256Sums("not-a-sum  officecli\n").size).toBe(0)
  })

  test("resolves runtime binary paths under the tools directory", () => {
    expect(runtimeBinaryPath("/repo/packages/desktop-electron/resources/tools", "win32")).toBe(
      path.join("/repo/packages/desktop-electron/resources/tools", "officecli.exe"),
    )
  })
})
