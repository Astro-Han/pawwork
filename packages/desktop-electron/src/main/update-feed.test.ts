import { describe, expect, test } from "bun:test"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"

const R2 = r2Feed("https://dl.pawwork.ai", "latest")
const GITHUB = githubFeed("Astro-Han", "pawwork", "latest")

const available = (version: string) => ({
  isUpdateAvailable: true,
  updateInfo: { version, files: [{ url: `app-${version}.zip` }] },
})

function feed(overrides: Partial<Parameters<typeof createUpdateFeed>[0]> = {}) {
  const calls = {
    setFeedURL: [] as string[],
    check: 0,
    download: 0,
  }
  const deps = {
    feeds: [R2, GITHUB] as FeedTarget[],
    setFeedURL: (options: { provider: string }) => {
      calls.setFeedURL.push(options.provider === "generic" ? "r2" : "github")
    },
    checkForUpdates: async () => {
      calls.check += 1
      return available("0.2.5")
    },
    downloadUpdate: async () => {
      calls.download += 1
    },
    timeoutMs: 10_000,
    log: () => undefined,
    error: () => undefined,
    // Default timer never fires; tests that exercise timeout override setTimer.
    setTimer: () => 0,
    clearTimer: () => undefined,
    ...overrides,
  }
  return { calls, feed: createUpdateFeed(deps) }
}

describe("update feed check", () => {
  test("uses the primary feed (R2) when its check succeeds", async () => {
    const setup = feed()
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["r2"])
    expect(setup.calls.check).toBe(1)
    expect(setup.feed.activeFeed()).toBe("r2")
  })

  test("falls back to GitHub when the R2 check throws", async () => {
    const setup = feed({
      checkForUpdates: async () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) throw new Error("r2 unreachable")
        return available("0.2.5")
      },
    })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["r2", "github"])
    expect(setup.calls.check).toBe(2)
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("falls back to GitHub when the R2 check times out", async () => {
    let timerCalls = 0
    const setup = feed({
      // R2 (call 1) hangs; GitHub (call 2) resolves.
      checkForUpdates: async () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) return new Promise(() => {})
        return available("0.2.5")
      },
      // Fire the timeout only for the first feed's check.
      setTimer: (callback: () => void) => {
        timerCalls += 1
        if (timerCalls === 1) callback()
        return timerCalls
      },
    })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["r2", "github"])
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("throws the last error when every feed fails", async () => {
    const setup = feed({
      checkForUpdates: async () => {
        setup.calls.check += 1
        throw new Error(setup.calls.check === 1 ? "r2 down" : "github down")
      },
    })
    await expect(setup.feed.check()).rejects.toThrow("github down")
    expect(setup.calls.setFeedURL).toEqual(["r2", "github"])
  })

  test("beta (single GitHub feed) never touches R2", async () => {
    const setup = feed({ feeds: [GITHUB] })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["github"])
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("a superseded (late) check does not change the active feed", async () => {
    let release: ((value: ReturnType<typeof available>) => void) | undefined
    const setup = feed({
      checkForUpdates: () => {
        setup.calls.check += 1
        if (setup.calls.check === 1) {
          return new Promise((resolve) => {
            release = (value) => resolve(value)
          })
        }
        return Promise.resolve(available("0.2.6"))
      },
    })

    const stale = setup.feed.check() // generation 1, pending on R2
    const fresh = await setup.feed.check() // generation 2, resolves on R2
    expect(fresh).toEqual(available("0.2.6"))
    expect(setup.feed.activeFeed()).toBe("r2")

    release?.(available("0.2.5"))
    await expect(stale).resolves.toEqual(available("0.2.5"))
    // The late generation-1 resolution must not clobber the active feed.
    expect(setup.feed.activeFeed()).toBe("r2")
  })
})

describe("update feed download", () => {
  test("downloads from the active feed without fallback on success", async () => {
    const setup = feed()
    await setup.feed.check()
    await setup.feed.download()
    expect(setup.calls.download).toBe(1)
    expect(setup.feed.activeFeed()).toBe("r2")
  })

  test("retries the download on GitHub when the R2 download fails", async () => {
    const setup = feed({
      downloadUpdate: async () => {
        setup.calls.download += 1
        if (setup.calls.download === 1) throw new Error("r2 blob 404")
      },
    })
    await setup.feed.check() // active = r2
    await setup.feed.download()
    expect(setup.calls.download).toBe(2)
    // re-check rebinds the provider to github before the second download
    expect(setup.calls.setFeedURL).toEqual(["r2", "github"])
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("does not retry when the GitHub download fails", async () => {
    const setup = feed({
      feeds: [GITHUB],
      downloadUpdate: async () => {
        setup.calls.download += 1
        throw new Error("github blob 404")
      },
    })
    await setup.feed.check() // active = github
    await expect(setup.feed.download()).rejects.toThrow("github blob 404")
    expect(setup.calls.download).toBe(1)
  })
})

describe("feed config builders", () => {
  test("r2Feed strips a trailing slash and uses the generic provider", () => {
    expect(r2Feed("https://dl.pawwork.ai/", "latest")).toEqual({
      label: "r2",
      options: { provider: "generic", url: "https://dl.pawwork.ai", channel: "latest" },
    })
  })

  test("githubFeed targets the owner/repo with the github provider", () => {
    expect(githubFeed("Astro-Han", "pawwork-beta", "latest")).toEqual({
      label: "github",
      options: { provider: "github", owner: "Astro-Han", repo: "pawwork-beta", channel: "latest" },
    })
  })
})
