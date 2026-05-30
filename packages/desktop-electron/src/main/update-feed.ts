// Runtime feed selection for the in-app updater (#219).
//
// PawWork mirrors every prod release to Cloudflare R2 (dl.pawwork.ai), which is
// fast and reachable from mainland China; GitHub is the global fallback. The
// baked app-update.yml stays `provider: github` (CI verifies that and it is the
// safest default); this module overrides the provider at runtime so each check
// prefers R2 and falls back to GitHub.
//
// Feed selection uses a CANCELLABLE reachability probe (HEAD on the channel
// file, aborted on timeout), then runs exactly one electron-updater
// checkForUpdates() against the winning feed. This is the load-bearing design
// choice: electron-updater's checkForUpdates() is not cancellable and mutates a
// shared provider on a single autoUpdater instance, so racing it with a timeout
// would let a slow R2 check resolve late and rebind the provider back to R2
// AFTER we fell back to GitHub — silently sending the download to the very feed
// the fallback exists to avoid. Probing first means only one real check ever
// runs, bound to the chosen feed; downloadUpdate() then reuses that provider.
//
// R2 serves byte-identical assets and the same latest*.yml as the GitHub
// release (see mirror-release-to-r2.ts), so the sha512 verification chain holds
// regardless of which feed wins.

export type FeedLabel = "r2" | "github"

export type GenericFeed = { provider: "generic"; url: string; channel: string }
export type GithubFeed = { provider: "github"; owner: string; repo: string; channel: string }
export type FeedOptions = GenericFeed | GithubFeed

export type FeedTarget = { label: FeedLabel; options: FeedOptions; probeUrl: string }

export type UpdateCheck = {
  isUpdateAvailable: boolean
  updateInfo?: { version?: string; files?: Array<{ url: string }> }
} | null

type Deps = {
  // Ordered by preference: primary first (R2), fallback last (GitHub). Beta has
  // no R2 mirror, so it gets a single GitHub feed.
  feeds: FeedTarget[]
  setFeedURL: (options: FeedOptions) => void
  checkForUpdates: () => Promise<UpdateCheck>
  downloadUpdate: () => Promise<unknown>
  // Cancellable reachability probe for a feed's channel file. Selecting the feed
  // with something we can actually abort — rather than racing the uncancellable
  // checkForUpdates — is what keeps a slow R2 from rebinding the provider after
  // a GitHub fallback.
  probe?: (url: string, signal: AbortSignal) => Promise<boolean>
  // Per-feed probe timeout; the probe is aborted (not abandoned) when it elapses.
  timeoutMs: number
  log: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, error: unknown) => void
  // Injected for tests; default to real timers in production wiring.
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const defaultProbe = async (url: string, signal: AbortSignal) => {
  const response = await fetch(url, { method: "HEAD", redirect: "follow", cache: "no-store", signal })
  return response.ok
}

export function createUpdateFeed(deps: Deps) {
  if (deps.feeds.length === 0) throw new Error("createUpdateFeed requires at least one feed")
  const probe = deps.probe ?? defaultProbe
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let activeLabel: FeedLabel = deps.feeds[0].label
  // Version from the last successful check, used to keep the download-fallback
  // from quietly swapping in a different release than the controller validated.
  let checkedVersion: string | undefined

  const reachable = async (feed: FeedTarget): Promise<boolean> => {
    const controller = new AbortController()
    const handle = setTimer(() => controller.abort(), deps.timeoutMs)
    try {
      return await probe(feed.probeUrl, controller.signal)
    } catch (error) {
      deps.error(`update feed probe via ${feed.label} failed`, error)
      return false
    } finally {
      clearTimer(handle)
    }
  }

  // Pick the first reachable feed and point electron-updater at it. The last
  // feed is selected without probing — if everything else is unreachable we
  // still want the real check to run against GitHub and surface a definitive
  // result rather than failing on the probe.
  const selectFeed = async (): Promise<FeedTarget> => {
    for (let index = 0; index < deps.feeds.length; index += 1) {
      const feed = deps.feeds[index]
      if (index === deps.feeds.length - 1) {
        deps.setFeedURL(feed.options)
        deps.log("update feed selected", { feed: feed.label, attempt: index + 1, total: deps.feeds.length })
        return feed
      }
      if (await reachable(feed)) {
        deps.setFeedURL(feed.options)
        deps.log("update feed selected", { feed: feed.label, attempt: index + 1, total: deps.feeds.length })
        return feed
      }
      deps.log("update feed unreachable, falling back", { from: feed.label, to: deps.feeds[index + 1].label })
    }
    // Unreachable: the loop always returns on the last feed.
    throw new Error("update feed selection exhausted")
  }

  // Run the real electron-updater check on the selected feed. If the check
  // rejects (R2 probe passed but the actual metadata fetch failed — DNS flip,
  // transient 5xx, or the 60 s socket timeout built into builder-util-runtime),
  // fall through to the next feed. The last feed throws on failure so the
  // caller gets a definitive error.
  const check = async (): Promise<UpdateCheck> => {
    const feeds = deps.feeds
    const selected = await selectFeed()
    const selectedIndex = feeds.indexOf(selected)

    for (let i = selectedIndex; i < feeds.length; i++) {
      const feed = feeds[i]
      if (i !== selectedIndex) {
        deps.setFeedURL(feed.options)
        deps.log("update check retrying on next feed", { feed: feed.label })
      }
      try {
        const result = await deps.checkForUpdates()
        activeLabel = feed.label
        checkedVersion = result?.updateInfo?.version
        return result
      } catch (error) {
        if (i === feeds.length - 1) throw error
        deps.error(`update check via ${feed.label} failed, falling back`, error)
      }
    }
    // Unreachable: the loop always returns or throws on the last feed.
    throw new Error("update check exhausted all feeds")
  }

  // Download from the active feed. If an R2 download fails and GitHub is
  // available, re-check against GitHub (to rebind the provider) and retry —
  // but only if GitHub offers the same version we validated, otherwise fail
  // closed so the controller never marks a version ready that it did not check.
  const download = async (): Promise<unknown> => {
    try {
      return await deps.downloadUpdate()
    } catch (error) {
      const github = deps.feeds.find((feed) => feed.label === "github")
      if (activeLabel === "github" || !github) throw error
      deps.error("update download via active feed failed, retrying on github", error)
      deps.setFeedURL(github.options)
      deps.log("update download fallback: re-checking on github")
      const recheck = await deps.checkForUpdates()
      const githubVersion = recheck?.updateInfo?.version
      if (githubVersion !== checkedVersion) {
        throw new Error(
          `github fallback version mismatch: expected ${checkedVersion ?? "unknown"}, got ${githubVersion ?? "unknown"}`,
        )
      }
      activeLabel = "github"
      return await deps.downloadUpdate()
    }
  }

  return {
    check,
    download,
    activeFeed: () => activeLabel,
  }
}

export function r2Feed(publicBase: string, channel: string, channelFile: string): FeedTarget {
  const base = publicBase.replace(/\/$/, "")
  return { label: "r2", options: { provider: "generic", url: base, channel }, probeUrl: `${base}/${channelFile}` }
}

export function githubFeed(owner: string, repo: string, channel: string, channelFile: string): FeedTarget {
  return {
    label: "github",
    options: { provider: "github", owner, repo, channel },
    probeUrl: `https://github.com/${owner}/${repo}/releases/latest/download/${channelFile}`,
  }
}
