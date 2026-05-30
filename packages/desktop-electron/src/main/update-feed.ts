// Runtime feed selection for the in-app updater (#219).
//
// PawWork mirrors every prod release to Cloudflare R2 (dl.pawwork.ai), which is
// fast and reachable from mainland China; GitHub is the global fallback. The
// baked app-update.yml stays `provider: github` (CI verifies that and it is the
// safest default); this module overrides the provider at runtime so each check
// tries R2 first and falls back to GitHub.
//
// electron-updater binds the download source at check time: downloadUpdate()
// reuses the updateInfoAndProvider captured by the last checkForUpdates(), not
// the baked yml. So feed selection must happen at check; the same active feed
// then serves the download. If an R2 download fails we re-check against GitHub
// before retrying the download.
//
// R2 serves byte-identical assets and the same latest*.yml as the GitHub
// release (see mirror-release-to-r2.ts), so the sha512 verification chain holds
// regardless of which feed wins, and a feed swap never points at a mismatched
// binary.

export type FeedLabel = "r2" | "github"

export type GenericFeed = { provider: "generic"; url: string; channel: string }
export type GithubFeed = { provider: "github"; owner: string; repo: string; channel: string }
export type FeedOptions = GenericFeed | GithubFeed

export type FeedTarget = { label: FeedLabel; options: FeedOptions }

export type UpdateCheck = { isUpdateAvailable: boolean; updateInfo?: { version?: string; files?: Array<{ url: string }> } } | null

type Deps = {
  // Ordered by preference: primary first (R2), fallback last (GitHub). Beta has
  // no R2 mirror, so it gets a single GitHub feed.
  feeds: FeedTarget[]
  setFeedURL: (options: FeedOptions) => void
  checkForUpdates: () => Promise<UpdateCheck>
  downloadUpdate: () => Promise<unknown>
  // Timeout for a single feed's check before moving to the next feed. Caps the
  // mainland "reachable but hanging" case; outright failures reject sooner.
  timeoutMs: number
  log: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
  // Injected for tests; defaults to a real timer in production wiring.
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

class FeedTimeoutError extends Error {
  constructor(label: FeedLabel, ms: number) {
    super(`Update check via ${label} timed out after ${ms}ms`)
    this.name = "FeedTimeoutError"
  }
}

export function createUpdateFeed(deps: Deps) {
  if (deps.feeds.length === 0) throw new Error("createUpdateFeed requires at least one feed")
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let activeLabel: FeedLabel = deps.feeds[0].label
  // Guards against a timed-out check resolving late and being mistaken for the
  // winning result. Each check() call bumps the token; stale resolutions are
  // ignored by the resolver, never by feed state.
  let generation = 0

  const withTimeout = async (label: FeedLabel): Promise<UpdateCheck> => {
    let handle: unknown
    const timeout = new Promise<never>((_, reject) => {
      handle = setTimer(() => reject(new FeedTimeoutError(label, deps.timeoutMs)), deps.timeoutMs)
    })
    try {
      return await Promise.race([deps.checkForUpdates(), timeout])
    } finally {
      clearTimer(handle)
    }
  }

  // Try each feed in order; the first check that resolves wins and becomes the
  // active feed. Throws the last feed's error only if every feed fails.
  const check = async (): Promise<UpdateCheck> => {
    generation += 1
    const token = generation
    let lastError: unknown
    for (let index = 0; index < deps.feeds.length; index += 1) {
      const feed = deps.feeds[index]
      const isLast = index === deps.feeds.length - 1
      try {
        deps.setFeedURL(feed.options)
        deps.log("update feed selected", { feed: feed.label, attempt: index + 1, total: deps.feeds.length })
        const result = await withTimeout(feed.label)
        if (token !== generation) {
          // A newer check() superseded us; do not touch active feed.
          deps.log("update check superseded, discarding result", { feed: feed.label })
          return result
        }
        activeLabel = feed.label
        return result
      } catch (error) {
        lastError = error
        deps.error(`update check via ${feed.label} failed`, error)
        if (isLast) throw error
        deps.log("falling back to next update feed", { from: feed.label, to: deps.feeds[index + 1].label })
      }
    }
    throw lastError
  }

  // Download from the active feed. If an R2 download fails and GitHub is
  // available, re-check against GitHub (to rebind updateInfoAndProvider) and
  // retry once. GitHub failures surface to the caller.
  const download = async (): Promise<unknown> => {
    try {
      return await deps.downloadUpdate()
    } catch (error) {
      const github = deps.feeds.find((feed) => feed.label === "github")
      if (activeLabel !== "github" && github) {
        deps.error("update download via active feed failed, retrying on github", error)
        deps.setFeedURL(github.options)
        await deps.checkForUpdates()
        activeLabel = "github"
        return await deps.downloadUpdate()
      }
      throw error
    }
  }

  return {
    check,
    download,
    activeFeed: () => activeLabel,
  }
}

export function r2Feed(publicBase: string, channel: string): FeedTarget {
  return { label: "r2", options: { provider: "generic", url: publicBase.replace(/\/$/, ""), channel } }
}

export function githubFeed(owner: string, repo: string, channel: string): FeedTarget {
  return { label: "github", options: { provider: "github", owner, repo, channel } }
}
