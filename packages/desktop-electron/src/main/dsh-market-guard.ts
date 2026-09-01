import { readFileSync } from "node:fs"
import { join } from "node:path"
import { gte, valid } from "semver"
import { describeExit } from "./dsh-sidecar"

const MARKET_NAME = "dshmarket"

/**
 * The community market release this build is verified against, and the DSH
 * release that verification ran on.
 *
 * The two move together: a DSH upgrade has to name the market release it was
 * validated with, and dsh-market-guard.test.ts fails until it does.
 */
export const VERIFIED_COMMUNITY_MARKET = {
  dsh: "0.1.2-alpha.3",
  market: "1.39.0",
} as const

// Bounds the wait on the startup page. Overrunning it is not fatal.
const UPGRADE_TIMEOUT_MS = 90_000
const OUTPUT_TAIL_CHARS = 4_000

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function installedMarketVersion(profileDir: string) {
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
 * Only a market that DSH will load counts: listed in `dsh.profile.bundles`,
 * installed in `node_modules`, and below the verified release. A bundle row
 * with no package behind it belongs to `pruneUnresolvableMarketBundle` and the
 * startup-failure dialog instead.
 */
export function outdatedMarketVersion(
  profileDir: string,
  verified: string = VERIFIED_COMMUNITY_MARKET.market,
) {
  if (!loadsMarketAtBoot(profileDir)) return undefined
  const installed = installedMarketVersion(profileDir)
  if (installed === undefined || valid(installed) === null) return undefined
  return gte(installed, verified) ? undefined : installed
}

type MarketPluginStream = { on(event: "data", listener: (data: Buffer | string) => void): unknown } | null

interface MarketPluginProcess {
  // Both streams: `dsh plugin` reports only that pnpm failed, on stderr, while
  // pnpm's own reason went to stdout ahead of it.
  readonly stdout: MarketPluginStream
  readonly stderr: MarketPluginStream
  kill(signal?: NodeJS.Signals): boolean
  on(event: "exit", listener: (code: number | null) => void): this
  // An EventEmitter with no "error" listener rethrows, which in the main
  // process is the app dying during startup.
  on(event: "error", listener: (error: Error) => void): this
}

type EnsureVerifiedCommunityMarketOptions = {
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
  verifiedVersion?: string
  timeoutMs?: number
  /** Called once, and only when an upgrade is about to run. */
  onUpgradeStart?: () => void
  log(message: string, detail?: Record<string, unknown>): void
}

// `dsh plugin` initializes the profile if needed, forwards to pnpm, and
// reconciles `dsh.profile.bundles` against what is installed. It never loads a
// bundle, so it is safe to run before DSH boots.
function runMarketPlugin(options: EnsureVerifiedCommunityMarketOptions, args: string[], signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = options.spawn(
      options.executable,
      [options.dshBin, "plugin", "--profile", "web", ...args],
      { cwd: options.profileDir, env: options.env, stdio: ["ignore", "pipe", "pipe"] },
    )
    let output = ""
    const collect = (data: Buffer | string) => {
      output = (output + data.toString()).slice(-OUTPUT_TAIL_CHARS)
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

/**
 * Bring the profile's community market up to the verified release before DSH is
 * given the chance to load it.
 *
 * A market listed in `dsh.profile.bundles` that throws on load aborts the whole
 * DSH boot, so this has to finish first. It never rejects: an unreachable
 * registry, a failed install or a timeout is logged and the launch continues.
 * A start with nothing to do costs one manifest read and no network.
 */
export async function ensureVerifiedCommunityMarket(options: EnsureVerifiedCommunityMarketOptions) {
  const verified = options.verifiedVersion ?? VERIFIED_COMMUNITY_MARKET.market
  const outdated = outdatedMarketVersion(options.profileDir, verified)
  if (outdated === undefined) return

  options.log("upgrading the community market before DSH starts", { from: outdated, to: verified })
  options.onUpgradeStart?.()
  try {
    await runMarketPlugin(
      options,
      // The version is named in this build rather than resolved automatically,
      // so pnpm's release-age cooldown does not apply. Left on, it either
      // rewrites the profile's pnpm-workspace.yaml or fails outright, depending
      // on whether pnpm believes it can prompt.
      ["add", "--config.minimumReleaseAge=0", `${MARKET_NAME}@${verified}`],
      AbortSignal.timeout(options.timeoutMs ?? UPGRADE_TIMEOUT_MS),
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
