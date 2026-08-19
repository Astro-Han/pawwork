import { describe, expect, test } from "vitest"
import { pendingUpdateCacheDir, UPDATER_CACHE_DIR_NAME } from "./updater-cache"

describe("updater cache path", () => {
  test("uses the same updater cache dir name as app-update.yml", () => {
    expect(UPDATER_CACHE_DIR_NAME).toBe("pawwork-updater")
  })

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
        env: { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\demo\\AppData\\Local\\pawwork-updater\\pending")
  })

  test("resolves Windows pending cache from localappdata casing when present", () => {
    expect(
      pendingUpdateCacheDir({
        platform: "win32",
        homedir: "C:\\Users\\demo",
        env: { localappdata: "D:\\Cache" },
      }),
    ).toBe("D:\\Cache\\pawwork-updater\\pending")
  })

  test("falls back to AppData\\Local on Windows when LOCALAPPDATA is missing", () => {
    expect(pendingUpdateCacheDir({ platform: "win32", homedir: "C:\\Users\\demo", env: {} })).toBe(
      "C:\\Users\\demo\\AppData\\Local\\pawwork-updater\\pending",
    )
  })

  test("ignores relative Windows cache roots from env", () => {
    expect(
      pendingUpdateCacheDir({
        platform: "win32",
        homedir: "C:\\Users\\demo",
        env: { LOCALAPPDATA: "relative-cache" },
      }),
    ).toBe("C:\\Users\\demo\\AppData\\Local\\pawwork-updater\\pending")
  })

  test("uses lowercase Windows cache root when uppercase env is relative", () => {
    expect(
      pendingUpdateCacheDir({
        platform: "win32",
        homedir: "C:\\Users\\demo",
        env: { LOCALAPPDATA: "relative-cache", localappdata: "D:\\Cache" },
      }),
    ).toBe("D:\\Cache\\pawwork-updater\\pending")
  })

})
