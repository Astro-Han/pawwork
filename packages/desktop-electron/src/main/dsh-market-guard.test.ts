import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gte } from "semver"
import { describe, expect, test } from "vitest"
import {
  MARKET_NAME,
  VERIFIED_COMMUNITY_MARKET,
  createMarketPluginRunner,
  ensureVerifiedCommunityMarket,
  installedMarketVersion,
  outdatedMarketVersion,
} from "./dsh-market-guard"

const require = createRequire(import.meta.url)

// The Desktop host's own view of the market, which ships as CommonJS into the
// DSH home and is therefore required rather than imported.
const { MARKET_MINIMUM_VERSION, MARKET_NAME: HOST_MARKET_NAME } = require(
  "../../resources/dsh/product/lib/desktop-host.cjs",
) as { MARKET_MINIMUM_VERSION: string; MARKET_NAME: string }

function profileWith(options: { declared?: string; installed?: string; bundled?: boolean }) {
  const profileDir = mkdtempSync(join(tmpdir(), "pawwork-market-guard-"))
  const bundled = options.bundled ?? options.declared !== undefined
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    dependencies: options.declared === undefined ? {} : { [MARKET_NAME]: options.declared },
    dsh: {
      profile: {
        bundles: bundled ? ["@deepseek-ai/dsh-base", MARKET_NAME] : ["@deepseek-ai/dsh-base"],
      },
    },
  }), "utf8")
  if (options.installed !== undefined) {
    const packageDir = join(profileDir, "node_modules", MARKET_NAME)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: MARKET_NAME, version: options.installed }),
      "utf8",
    )
  }
  return profileDir
}

function recordingRunner(outcome: () => Promise<void> = () => Promise.resolve()) {
  const calls: Array<{ args: string[]; signal: AbortSignal }> = []
  return {
    calls,
    run: (args: string[], signal: AbortSignal) => {
      calls.push({ args, signal })
      return outcome()
    },
  }
}

function fakeSpawn(behaviour: (child: FakeChild) => void) {
  const spawns: Array<{ executable: string; args: string[]; options: unknown }> = []
  return {
    spawns,
    spawn: (executable: string, args: string[], options: unknown) => {
      const child = new FakeChild()
      spawns.push({ executable, args, options })
      queueMicrotask(() => behaviour(child))
      return child
    },
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  signals: Array<NodeJS.Signals | undefined> = []

  kill(signal?: NodeJS.Signals) {
    this.signals.push(signal)
    return true
  }
}

describe("the verified market release", () => {
  // The tripwire that would have caught 1.34.0: it is only correct to inherit
  // this pin while the DSH under it has not moved. Upgrading DSH means naming
  // the market release the upgrade was validated against.
  test("names the DSH release it was validated against", () => {
    const installed = JSON.parse(
      readFileSync(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"),
    ) as { version: string }

    expect(VERIFIED_COMMUNITY_MARKET.dsh).toBe(installed.version)
  })

  test("is at or above the host compatibility floor, which stays a separate contract", () => {
    expect(MARKET_NAME).toBe(HOST_MARKET_NAME)
    expect(gte(VERIFIED_COMMUNITY_MARKET.market, MARKET_MINIMUM_VERSION)).toBe(true)
  })
})

describe("outdatedMarketVersion", () => {
  test("names an active market below the verified release", () => {
    const profileDir = profileWith({ declared: "1.34.0", installed: "1.34.0" })

    expect(outdatedMarketVersion(profileDir, "1.39.0")).toBe("1.34.0")
    expect(installedMarketVersion(profileDir)).toBe("1.34.0")
  })

  test("leaves a market at or above the verified release alone", () => {
    expect(outdatedMarketVersion(profileWith({ declared: "1.39.0", installed: "1.39.0" }), "1.39.0")).toBeUndefined()
    expect(outdatedMarketVersion(profileWith({ declared: "^1.39.0", installed: "1.40.2" }), "1.39.0")).toBeUndefined()
  })

  test("ignores a market the profile does not load at boot", () => {
    const profileDir = profileWith({ declared: "1.34.0", installed: "1.34.0", bundled: false })

    expect(outdatedMarketVersion(profileDir, "1.39.0")).toBeUndefined()
  })

  // The orphan row is pruneUnresolvableMarketBundle's and the startup-failure
  // dialog's to repair; installing over it here would mask their work.
  test("ignores a bundle row with no package behind it", () => {
    const profileDir = profileWith({ declared: "1.34.0" })

    expect(outdatedMarketVersion(profileDir, "1.39.0")).toBeUndefined()
  })

  test("ignores a profile with no market and an unreadable manifest", () => {
    expect(outdatedMarketVersion(profileWith({}), "1.39.0")).toBeUndefined()
    expect(outdatedMarketVersion(join(tmpdir(), "pawwork-market-guard-absent"), "1.39.0")).toBeUndefined()
  })

  test("ignores a version it cannot compare", () => {
    const profileDir = profileWith({ declared: "workspace:*", installed: "next" })

    expect(outdatedMarketVersion(profileDir, "1.39.0")).toBeUndefined()
  })
})

describe("ensureVerifiedCommunityMarket", () => {
  test("installs the verified release before DSH starts", async () => {
    const profileDir = profileWith({ declared: "1.34.0", installed: "1.34.0" })
    const runner = recordingRunner()
    const messages: string[] = []
    let notices = 0

    await ensureVerifiedCommunityMarket({
      profileDir,
      runPlugin: runner.run,
      verifiedVersion: "1.39.0",
      onUpgradeStart: () => { notices += 1 },
      log: (message) => messages.push(message),
    })

    expect(runner.calls.map((call) => call.args)).toEqual([
      ["add", "--config.minimumReleaseAge=0", "dshmarket@1.39.0"],
    ])
    expect(runner.calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(notices).toBe(1)
    expect(messages).toEqual([
      "upgrading the community market before DSH starts",
      "community market upgraded",
    ])
  })

  test("does nothing, and says nothing, on a normal start", async () => {
    const runner = recordingRunner()
    const messages: string[] = []
    let notices = 0

    await ensureVerifiedCommunityMarket({
      profileDir: profileWith({ declared: "1.39.0", installed: "1.39.0" }),
      runPlugin: runner.run,
      verifiedVersion: "1.39.0",
      onUpgradeStart: () => { notices += 1 },
      log: (message) => messages.push(message),
    })

    expect(runner.calls).toEqual([])
    expect(notices).toBe(0)
    expect(messages).toEqual([])
  })

  // Degrade, never block: an app that cannot reach npm still has to open.
  test("continues the launch when the upgrade fails", async () => {
    const runner = recordingRunner(() => Promise.reject(new Error("ENOTFOUND registry.npmjs.org")))
    const logged: Array<Record<string, unknown> | undefined> = []

    await expect(ensureVerifiedCommunityMarket({
      profileDir: profileWith({ declared: "1.34.0", installed: "1.34.0" }),
      runPlugin: runner.run,
      verifiedVersion: "1.39.0",
      log: (_message, detail) => logged.push(detail),
    })).resolves.toBeUndefined()

    expect(logged.at(-1)).toEqual({ from: "1.34.0", to: "1.39.0", error: "ENOTFOUND registry.npmjs.org" })
  })
})

describe("createMarketPluginRunner", () => {
  test("runs dsh plugin against the web profile in the sidecar environment", async () => {
    const spawner = fakeSpawn((child) => child.emit("exit", 0))
    const run = createMarketPluginRunner({
      dshBin: "/app/dsh/bin.js",
      env: { DSH_HOME: "/home/u/.pawwork/dsh" },
      executable: "/app/PawWork",
      profileDir: "/home/u/.pawwork/dsh/profiles/web",
      spawn: spawner.spawn,
    })

    await expect(run(["add", "dshmarket@1.39.0"], AbortSignal.timeout(1_000))).resolves.toBeUndefined()
    expect(spawner.spawns).toEqual([{
      executable: "/app/PawWork",
      args: ["/app/dsh/bin.js", "plugin", "--profile", "web", "add", "dshmarket@1.39.0"],
      options: {
        cwd: "/home/u/.pawwork/dsh/profiles/web",
        env: { DSH_HOME: "/home/u/.pawwork/dsh" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    }])
  })

  // pnpm's reason lands on stdout and `dsh plugin`'s summary on stderr; a log
  // carrying only the summary says nothing anyone can act on.
  test("reports the failure output of a non-zero exit from both streams", async () => {
    const spawner = fakeSpawn((child) => {
      child.stdout.emit("data", " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dshmarket\n")
      child.stderr.emit("data", "dsh: pnpm failed in profile directory /profile\n")
      child.emit("exit", 1)
    })
    const run = createMarketPluginRunner({
      dshBin: "/app/dsh/bin.js",
      env: {},
      executable: "/app/PawWork",
      profileDir: "/profile",
      spawn: spawner.spawn,
    })

    await expect(run(["add", "dshmarket@9.9.9"], AbortSignal.timeout(1_000)))
      .rejects.toThrow(/exited with code 1: ERR_PNPM_FETCH_404[\s\S]*pnpm failed in profile directory/)
  })

  test("terminates the install when the deadline passes", async () => {
    let killed: FakeChild | undefined
    const spawner = fakeSpawn((child) => { killed = child })
    const run = createMarketPluginRunner({
      dshBin: "/app/dsh/bin.js",
      env: {},
      executable: "/app/PawWork",
      profileDir: "/profile",
      spawn: spawner.spawn,
    })

    const pending = run(["add", "dshmarket@1.39.0"], AbortSignal.timeout(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    killed?.emit("exit", null)

    await expect(pending).rejects.toThrow(/timed out/)
    expect(killed?.signals).toEqual(["SIGTERM"])
  })

  test("reports a spawn failure instead of crashing the main process", async () => {
    const spawner = fakeSpawn((child) => child.emit("error", new Error("EACCES")))
    const run = createMarketPluginRunner({
      dshBin: "/app/dsh/bin.js",
      env: {},
      executable: "/app/PawWork",
      profileDir: "/profile",
      spawn: spawner.spawn,
    })

    await expect(run(["add", "dshmarket@1.39.0"], AbortSignal.timeout(1_000))).rejects.toThrow("EACCES")
  })
})
