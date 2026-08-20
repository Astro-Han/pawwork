import { describe, expect, test } from "vitest"
import { pendingUpdateCacheDir } from "./updater-cache"

describe("updater cache path", () => {
  test("resolves macOS pending cache from the user library cache root", () => {
    expect(pendingUpdateCacheDir({ platform: "darwin", homedir: "/Users/demo", env: {} })).toBe(
      "/Users/demo/Library/Caches/pawwork-updater/pending",
    )
  })

  test("resolves Windows pending cache from LOCALAPPDATA when present", () => {
    expect(
      pendingUpdateCacheDir({
        platform: "win32",
        homedir: "C:\\Users\\demo",
        env: { LOCALAPPDATA: "D:\\Cache" },
      }),
    ).toBe("D:\\Cache\\pawwork-updater\\pending")
  })

  test("falls back to AppData\\Local on Windows when LOCALAPPDATA is missing", () => {
    expect(pendingUpdateCacheDir({ platform: "win32", homedir: "C:\\Users\\demo", env: {} })).toBe(
      "C:\\Users\\demo\\AppData\\Local\\pawwork-updater\\pending",
    )
  })

})
