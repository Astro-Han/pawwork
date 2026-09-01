import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  VERIFIED_COMMUNITY_MARKET,
  ensureVerifiedCommunityMarket,
  outdatedMarketVersion,
} from "./dsh-market-guard"

const require = createRequire(import.meta.url)

function profileWith(options: { declared?: string; installed?: string; bundled?: boolean }) {
  const profileDir = mkdtempSync(join(tmpdir(), "pawwork-market-guard-"))
  const bundled = options.bundled ?? options.declared !== undefined
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-web",
    dependencies: options.declared === undefined ? {} : { dshmarket: options.declared },
    dsh: {
      profile: { bundles: bundled ? ["@deepseek-ai/dsh-base", "dshmarket"] : ["@deepseek-ai/dsh-base"] },
    },
  }), "utf8")
  if (options.installed !== undefined) {
    const packageDir = join(profileDir, "node_modules", "dshmarket")
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "dshmarket", version: options.installed }),
      "utf8",
    )
  }
  return profileDir
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

function guard(profileDir: string, behaviour: (child: FakeChild) => void = (child) => child.emit("exit", 0)) {
  const spawns: Array<{ executable: string; args: string[]; options: unknown }> = []
  const messages: Array<{ message: string; detail?: Record<string, unknown> }> = []
  const children: FakeChild[] = []
  let notices = 0
  return {
    spawns,
    messages,
    children,
    notices: () => notices,
    run: (verifiedVersion = "1.39.0", timeoutMs?: number) => ensureVerifiedCommunityMarket({
      dshBin: "/app/dsh/bin.js",
      env: { DSH_HOME: "/home/u/.pawwork/dsh" },
      executable: "/app/PawWork",
      profileDir,
      spawn: (executable, args, options) => {
        const child = new FakeChild()
        children.push(child)
        spawns.push({ executable, args, options })
        queueMicrotask(() => behaviour(child))
        return child
      },
      verifiedVersion,
      timeoutMs,
      onUpgradeStart: () => { notices += 1 },
      log: (message, detail) => messages.push({ message, detail }),
    }),
  }
}

// The tripwire for a forgotten pin: inheriting this market release is only
// correct while the DSH under it has not moved.
test("the verified market release names the DSH release it was validated against", () => {
  const installed = JSON.parse(
    readFileSync(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"),
  ) as { version: string }

  expect(VERIFIED_COMMUNITY_MARKET.dsh).toBe(installed.version)
})

describe("outdatedMarketVersion", () => {
  test("names an active market below the verified release", () => {
    expect(outdatedMarketVersion(profileWith({ declared: "1.34.0", installed: "1.34.0" }), "1.39.0")).toBe("1.34.0")
  })

  test("leaves a market at or above the verified release alone", () => {
    expect(outdatedMarketVersion(profileWith({ declared: "1.39.0", installed: "1.39.0" }), "1.39.0")).toBeUndefined()
    expect(outdatedMarketVersion(profileWith({ declared: "^1.39.0", installed: "1.40.2" }), "1.39.0")).toBeUndefined()
  })

  test("ignores a market the profile does not load at boot", () => {
    const profileDir = profileWith({ declared: "1.34.0", installed: "1.34.0", bundled: false })

    expect(outdatedMarketVersion(profileDir, "1.39.0")).toBeUndefined()
  })

  test("ignores a bundle row with no package behind it", () => {
    expect(outdatedMarketVersion(profileWith({ declared: "1.34.0" }), "1.39.0")).toBeUndefined()
  })

  test("ignores a profile with no market and an unreadable manifest", () => {
    expect(outdatedMarketVersion(profileWith({}), "1.39.0")).toBeUndefined()
    expect(outdatedMarketVersion(join(tmpdir(), "pawwork-market-guard-absent"), "1.39.0")).toBeUndefined()
  })

  test("ignores a version it cannot compare", () => {
    expect(outdatedMarketVersion(profileWith({ declared: "workspace:*", installed: "next" }), "1.39.0")).toBeUndefined()
  })
})

describe("ensureVerifiedCommunityMarket", () => {
  test("installs the verified release through dsh plugin before DSH starts", async () => {
    const harness = guard(profileWith({ declared: "1.34.0", installed: "1.34.0" }))

    await harness.run()

    expect(harness.spawns).toEqual([{
      executable: "/app/PawWork",
      args: [
        "/app/dsh/bin.js",
        "plugin",
        "--profile",
        "web",
        "add",
        "--config.minimumReleaseAge=0",
        "dshmarket@1.39.0",
      ],
      options: {
        cwd: expect.stringContaining("pawwork-market-guard-") as unknown,
        env: { DSH_HOME: "/home/u/.pawwork/dsh" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    }])
    expect(harness.notices()).toBe(1)
    expect(harness.messages.map((entry) => entry.message)).toEqual([
      "upgrading the community market before DSH starts",
      "community market upgraded",
    ])
  })

  test("does nothing, and says nothing, on a normal start", async () => {
    const harness = guard(profileWith({ declared: "1.39.0", installed: "1.39.0" }))

    await harness.run()

    expect(harness.spawns).toEqual([])
    expect(harness.notices()).toBe(0)
    expect(harness.messages).toEqual([])
  })

  // Degrade, never block: an app that cannot reach npm still has to open.
  test("continues the launch when the install fails, reporting both output streams", async () => {
    const harness = guard(profileWith({ declared: "1.34.0", installed: "1.34.0" }), (child) => {
      child.stdout.emit("data", " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dshmarket\n")
      child.stderr.emit("data", "dsh: pnpm failed in profile directory /profile\n")
      child.emit("exit", 1)
    })

    await expect(harness.run()).resolves.toBeUndefined()

    expect(harness.messages.at(-1)?.message).toBe("community market upgrade failed, starting with the installed market")
    expect(harness.messages.at(-1)?.detail?.error).toMatch(
      /exited with code 1: ERR_PNPM_FETCH_404[\s\S]*pnpm failed in profile directory/,
    )
  })

  test("continues the launch when the install cannot be spawned", async () => {
    const harness = guard(
      profileWith({ declared: "1.34.0", installed: "1.34.0" }),
      (child) => child.emit("error", new Error("EACCES")),
    )

    await expect(harness.run()).resolves.toBeUndefined()

    expect(harness.messages.at(-1)?.detail?.error).toBe("EACCES")
  })

  test("terminates an install that outruns the deadline, and still starts", async () => {
    // A wedged install: it never exits on its own.
    const harness = guard(profileWith({ declared: "1.34.0", installed: "1.34.0" }), () => {})
    const started = harness.run("1.39.0", 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const child of harness.children) child.emit("exit", null)

    await expect(started).resolves.toBeUndefined()

    expect(harness.children[0]?.signals).toEqual(["SIGTERM"])
    expect(harness.messages.at(-1)?.detail?.error).toMatch(/timed out/)
  })
})
