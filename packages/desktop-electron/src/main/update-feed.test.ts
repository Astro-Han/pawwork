import { describe, expect, test } from "bun:test"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"

const R2 = r2Feed("https://dl.pawwork.ai", "latest", "latest-mac.yml")
const GITHUB = githubFeed("Astro-Han", "pawwork", "latest", "latest-mac.yml")

const available = (version: string) => ({
  isUpdateAvailable: true,
  updateInfo: { version, files: [{ url: `app-${version}.zip` }] },
})

function feed(overrides: Partial<Parameters<typeof createUpdateFeed>[0]> = {}) {
  const calls = {
    setFeedURL: [] as string[],
    check: 0,
    download: 0,
    probe: [] as string[],
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
    probe: async (url: string) => {
      calls.probe.push(url)
      return true
    },
    timeoutMs: 10_000,
    log: () => undefined,
    error: () => undefined,
    setTimer: () => 0,
    clearTimer: () => undefined,
    ...overrides,
  }
  return { calls, feed: createUpdateFeed(deps) }
}

describe("update feed selection", () => {
  test("selects R2 when its probe succeeds and runs exactly one check", async () => {
    const setup = feed()
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.probe).toEqual(["https://dl.pawwork.ai/latest-mac.yml"])
    expect(setup.calls.setFeedURL).toEqual(["r2"])
    expect(setup.calls.check).toBe(1)
    expect(setup.feed.activeFeed()).toBe("r2")
  })

  test("falls back to GitHub when the R2 probe reports unreachable", async () => {
    const setup = feed({ probe: async () => false })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["github"])
    expect(setup.calls.check).toBe(1)
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("falls back to GitHub when the R2 probe throws", async () => {
    const setup = feed({
      probe: async () => {
        throw new Error("r2 dns failure")
      },
    })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["github"])
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("aborts a hanging R2 probe on timeout, then falls back to GitHub with a single check", async () => {
    const setup = feed({
      // R2 probe never resolves on its own; it only rejects when aborted.
      probe: (_url: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(new Error("aborted"))
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
      // Fire the per-probe timeout immediately so the abort path runs.
      setTimer: (callback: () => void) => {
        callback()
        return 0
      },
    })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["github"])
    // The load-bearing assertion (#219 P1): only one real electron-updater check
    // ever runs, bound to the fallback feed — no abandoned R2 check can rebind it.
    expect(setup.calls.check).toBe(1)
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("beta (single GitHub feed) selects GitHub without probing", async () => {
    const setup = feed({ feeds: [GITHUB] })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.probe).toEqual([])
    expect(setup.calls.setFeedURL).toEqual(["github"])
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("falls back to GitHub when R2 probe succeeds but R2 check rejects", async () => {
    let checkCount = 0
    const setup = feed({
      checkForUpdates: async () => {
        checkCount += 1
        if (checkCount === 1) throw new Error("R2 metadata fetch 503")
        return available("0.2.5")
      },
    })
    await expect(setup.feed.check()).resolves.toEqual(available("0.2.5"))
    expect(setup.calls.setFeedURL).toEqual(["r2", "github"])
    expect(checkCount).toBe(2)
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("throws when R2 probe succeeds, R2 check rejects, and GitHub check also rejects", async () => {
    const setup = feed({
      checkForUpdates: async () => {
        throw new Error("both feeds down")
      },
    })
    await expect(setup.feed.check()).rejects.toThrow("both feeds down")
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

  test("retries the download on GitHub when the R2 download fails and versions match", async () => {
    const setup = feed({
      downloadUpdate: async () => {
        setup.calls.download += 1
        if (setup.calls.download === 1) throw new Error("r2 blob 404")
      },
    })
    await setup.feed.check() // active = r2, checkedVersion = 0.2.5
    await setup.feed.download()
    expect(setup.calls.download).toBe(2)
    expect(setup.calls.setFeedURL).toEqual(["r2", "github"]) // re-point before retry
    expect(setup.feed.activeFeed()).toBe("github")
  })

  test("fails closed when the GitHub fallback offers a different version", async () => {
    const setup = feed({
      checkForUpdates: async () => {
        setup.calls.check += 1
        // first (R2) check: 0.2.5; second (github re-check): 0.2.6
        return setup.calls.check === 1 ? available("0.2.5") : available("0.2.6")
      },
      downloadUpdate: async () => {
        setup.calls.download += 1
        throw new Error("r2 blob 404")
      },
    })
    await setup.feed.check()
    await expect(setup.feed.download()).rejects.toThrow("github fallback version mismatch")
    expect(setup.calls.download).toBe(1) // second download never attempted
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

  test("fails closed when the GitHub fallback re-check rejects", async () => {
    let checkCount = 0
    const setup = feed({
      checkForUpdates: async () => {
        checkCount += 1
        if (checkCount === 1) return available("0.2.5")
        throw new Error("github re-check timeout")
      },
      downloadUpdate: async () => {
        setup.calls.download += 1
        throw new Error("r2 download failed")
      },
    })
    await setup.feed.check() // active = r2, version 0.2.5
    await expect(setup.feed.download()).rejects.toThrow("github re-check timeout")
    expect(setup.calls.download).toBe(1) // only the failed R2 download, no GitHub retry
  })
})

describe("feed config builders", () => {
  test("r2Feed strips a trailing slash and builds the generic feed + probe URL", () => {
    expect(r2Feed("https://dl.pawwork.ai/", "latest", "latest-mac.yml")).toEqual({
      label: "r2",
      options: { provider: "generic", url: "https://dl.pawwork.ai", channel: "latest" },
      probeUrl: "https://dl.pawwork.ai/latest-mac.yml",
    })
  })

  test("githubFeed targets owner/repo and the releases/latest probe URL", () => {
    expect(githubFeed("Astro-Han", "pawwork-beta", "latest", "latest.yml")).toEqual({
      label: "github",
      options: { provider: "github", owner: "Astro-Han", repo: "pawwork-beta", channel: "latest" },
      probeUrl: "https://github.com/Astro-Han/pawwork-beta/releases/latest/download/latest.yml",
    })
  })
})
