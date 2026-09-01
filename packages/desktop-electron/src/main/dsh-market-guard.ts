import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gte, valid } from "semver"
import { describeExit } from "./dsh-sidecar"

/** The community market package, spelled the way `dsh plugin add` records it. */
export const MARKET_NAME = "dshmarket"

/**
 * The community market release PawWork ships against, paired with the DSH it was
 * verified on.
 *
 * The market version is part of PawWork's release contract because nothing else
 * moves it: `dsh plugin add` writes an exact version into the profile, pnpm then
 * installs from the profile lockfile, and the market can only update itself once
 * it loads — which is precisely what a DSH upgrade it has not caught up with
 * takes away. The market sits in `dsh.profile.bundles`, so a market that throws
 * on load makes cordis roll back the whole config tree and DSH exit: users who
 * merely turned the market on once cannot open the app at all.
 *
 * `dsh` is what keeps this pair honest. The sentinel in dsh-market-guard.test.ts
 * fails as soon as the shipped DSH moves, so a DSH upgrade has to name the
 * market release it was validated against instead of silently inheriting this
 * one — which is how 1.34.0 was left behind across 0.1.2-alpha.3.
 */
export const VERIFIED_COMMUNITY_MARKET = {
  dsh: "0.1.2-alpha.3",
  market: "1.39.0",
} as const

// Long enough for a cold pnpm fetch of one package over a slow link, short
// enough that an unreachable registry does not hold the window on the startup
// page for minutes. Overrunning it is not fatal: the launch continues either way.
const MARKET_UPGRADE_TIMEOUT_MS = 90_000

const PLUGIN_OUTPUT_TAIL_CHARS = 4_000

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/** The market version materialized in the profile, or undefined when none is. */
export function installedMarketVersion(profileDir: string) {
  const manifest = readJson(join(profileDir, "node_modules", MARKET_NAME, "package.json")) as
    | { version?: unknown }
    | undefined
  return typeof manifest?.version === "string" ? manifest.version : undefined
}

function loadsMarketAtBoot(profileDir: string) {
  const manifest = readJson(join(profileDir, "package.json")) as
    | { dsh?: { profile?: { bundles?: unknown } } }
    | undefined
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.includes(MARKET_NAME)
}

/**
 * The market version this launch has to replace, or undefined when there is
 * nothing to do.
 *
 * Deliberately narrow. Only a market DSH will actually load — declared in
 * `dsh.profile.bundles` *and* materialized in `node_modules` — can take the boot
 * down, and only one below the verified release is untested against the DSH this
 * build ships. A bundle row with no package behind it is a different failure
 * that `pruneUnresolvableMarketBundle` and the startup-failure dialog already
 * own; installing over it here would hide their repair rather than help it.
 */
export function outdatedMarketVersion(
  profileDir: string,
  verified: string = VERIFIED_COMMUNITY_MARKET.market,
) {
  if (!loadsMarketAtBoot(profileDir)) return undefined
  const installed = installedMarketVersion(profileDir)
  // An unparseable version is not something to reason about, let alone overwrite.
  if (installed === undefined || valid(installed) === null) return undefined
  return gte(installed, verified) ? undefined : installed
}

/** One `dsh plugin` invocation; rejects on anything but a clean exit. */
export type MarketPluginRunner = (args: string[], signal: AbortSignal) => Promise<void>

type MarketPluginStream = { on(event: "data", listener: (data: Buffer | string) => void): unknown } | null

interface MarketPluginProcess {
  // Both streams, because the diagnosis is split across them: `dsh plugin` says
  // only that pnpm failed, on its stderr, while pnpm's own reason — a blocked
  // build script, an unreachable registry — went to stdout before that.
  readonly stdout: MarketPluginStream
  readonly stderr: MarketPluginStream
  kill(signal?: NodeJS.Signals): boolean
  on(event: "exit", listener: (code: number | null) => void): this
  // Listened to because it must be: an EventEmitter with no "error" listener
  // rethrows, and in the main process that is the app dying during startup.
  on(event: "error", listener: (error: Error) => void): this
}

type CreateMarketPluginRunnerOptions = {
  dshBin: string
  /** The DSH sidecar environment: it carries DSH_HOME and the pnpm shim on PATH. */
  env: NodeJS.ProcessEnv
  executable: string
  profileDir: string
  spawn(
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
  ): MarketPluginProcess
}

/**
 * Runs profile plugin commands the way the Desktop host does, but from the main
 * process and before the sidecar exists. `dsh plugin` is a thin pnpm forwarder —
 * it initializes the profile if needed, runs pnpm in it, then reconciles
 * `dsh.profile.bundles` against what is installed — so it never loads a bundle
 * and cannot hit the failure this guard exists to prevent.
 */
export function createMarketPluginRunner(options: CreateMarketPluginRunnerOptions): MarketPluginRunner {
  return (args, signal) => new Promise<void>((resolve, reject) => {
    const child = options.spawn(
      options.executable,
      [options.dshBin, "plugin", "--profile", "web", ...args],
      { cwd: options.profileDir, env: options.env, stdio: ["ignore", "pipe", "pipe"] },
    )
    let output = ""
    const collect = (data: Buffer | string) => {
      output = (output + data.toString()).slice(-PLUGIN_OUTPUT_TAIL_CHARS)
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    const abort = () => void child.kill("SIGTERM")
    signal.addEventListener("abort", abort, { once: true })
    const settle = (finish: () => void) => {
      signal.removeEventListener("abort", abort)
      finish()
    }
    child.on("error", (error) => settle(() => reject(error)))
    child.on("exit", (code) => settle(() => {
      if (code === 0 && !signal.aborted) {
        resolve()
        return
      }
      const cause = signal.aborted ? "timed out" : `exited ${describeExit(code)}`
      reject(new Error(`dsh plugin ${cause}${output.trim() === "" ? "" : `: ${output.trim()}`}`))
    }))
  })
}

type EnsureVerifiedCommunityMarketOptions = {
  profileDir: string
  runPlugin: MarketPluginRunner
  verifiedVersion?: string
  timeoutMs?: number
  /** Called once, and only when an upgrade is really about to run. */
  onUpgradeStart?: () => void
  log(message: string, detail?: Record<string, unknown>): void
}

/**
 * Bring the profile's community market up to the release this build was verified
 * against, before DSH is given the chance to load it.
 *
 * Never rejects and never blocks a launch it cannot repair: an unreachable
 * registry, a failed install or a timeout are logged and the start continues, so
 * the market can never be the reason the app does not open. A normal start pays
 * one `readFileSync` of the profile manifest and touches no network.
 */
export async function ensureVerifiedCommunityMarket(options: EnsureVerifiedCommunityMarketOptions) {
  const verified = options.verifiedVersion ?? VERIFIED_COMMUNITY_MARKET.market
  const outdated = outdatedMarketVersion(options.profileDir, verified)
  if (outdated === undefined) return

  options.log("upgrading the community market before DSH starts", { from: outdated, to: verified })
  options.onUpgradeStart?.()
  try {
    await options.runPlugin(
      // The release-age cooldown is pnpm's protection against *automatically*
      // picking up a version nobody vetted. This version is the opposite: one
      // release, named in this build, verified before shipping. Leaving the gate
      // on would make a startup repair depend on how pnpm decides to handle a
      // young version — silently rewriting the user's profile
      // `pnpm-workspace.yaml` when it can prompt, failing when it cannot.
      ["add", "--config.minimumReleaseAge=0", `${MARKET_NAME}@${verified}`],
      AbortSignal.timeout(options.timeoutMs ?? MARKET_UPGRADE_TIMEOUT_MS),
    )
  } catch (error) {
    options.log("community market upgrade failed, starting with the installed market", {
      from: outdated,
      to: verified,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  options.log("community market upgraded", {
    from: outdated,
    to: installedMarketVersion(options.profileDir),
  })
}
