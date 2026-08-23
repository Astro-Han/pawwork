import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  assertDshPluginRequest,
  createDshCommunityMarketManager,
  DSH_COMMUNITY_MARKET_TARGET,
} from "./dsh-plugins"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function profileHome(manifest: unknown) {
  const home = mkdtempSync(join(tmpdir(), "pawwork-dsh-market-"))
  temporaryDirectories.push(home)
  const profile = join(home, "profiles", "web")
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return home
}

function writeMarketManifest(home: string, version = "1.21.0") {
  writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({
    dependencies: { dshmarket: version },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dshmarket"] } },
  }))
}

describe("PawWork DSH community market connector", () => {
  test("accepts requests only from the owned DSH main frame", () => {
    expect(() => assertDshPluginRequest({
      dshUrl: "http://127.0.0.1:43123/",
      isMainFrame: true,
      senderUrl: "http://127.0.0.1:43123/settings/plugins",
    })).not.toThrow()
    expect(() => assertDshPluginRequest({
      dshUrl: "http://127.0.0.1:43123/",
      isMainFrame: true,
      senderUrl: "https://example.com/",
    })).toThrow("owned product frame")
    expect(() => assertDshPluginRequest({
      dshUrl: "http://127.0.0.1:43123/",
      isMainFrame: false,
      senderUrl: "http://127.0.0.1:43123/embedded",
    })).toThrow("owned product frame")
  })

  test("reports the market enabled only when it is both installed and active", async () => {
    const home = profileHome({
      dependencies: { dshmarket: "1.21.0", "plain-library": "4.5.6" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "plain-library"] } },
    })
    const manager = createDshCommunityMarketManager({ home, run: vi.fn() })

    await expect(manager.status()).resolves.toEqual({ enabled: false, version: "1.21.0" })
    writeMarketManifest(home)
    await expect(manager.status()).resolves.toEqual({ enabled: true, version: "1.21.0" })
  })

  test("exposes no arbitrary package operation and enables one pinned market target", async () => {
    const home = profileHome({ dependencies: {}, dsh: { profile: { bundles: [] } } })
    const run = vi.fn(async () => {
      writeMarketManifest(home)
      return { stderr: "", stdout: "installed" }
    })
    const manager = createDshCommunityMarketManager({ home, run })

    expect(Object.keys(manager)).toEqual(["status", "enable"])
    await expect(manager.enable()).resolves.toEqual({ enabled: true, version: "1.21.0" })
    expect(run).toHaveBeenCalledWith([
      "plugin", "--profile", "web", "add", DSH_COMMUNITY_MARKET_TARGET, "--save-exact",
    ])
  })

  test("does not reinstall an already active market", async () => {
    const home = profileHome({
      dependencies: { dshmarket: "1.21.0" },
      dsh: { profile: { bundles: ["dshmarket"] } },
    })
    const run = vi.fn()
    const manager = createDshCommunityMarketManager({ home, run })

    await expect(manager.enable()).resolves.toEqual({ enabled: true, version: "1.21.0" })
    expect(run).not.toHaveBeenCalled()
  })

  test("rejects a second enable while the profile package manager is running", async () => {
    const home = profileHome({ dependencies: {}, dsh: { profile: { bundles: [] } } })
    let release!: () => void
    const running = new Promise<void>((resolve) => { release = resolve })
    const manager = createDshCommunityMarketManager({
      home,
      run: async () => {
        await running
        writeMarketManifest(home)
        return { stderr: "", stdout: "" }
      },
    })

    const first = manager.enable()
    await expect(manager.enable()).rejects.toThrow("Another plugin operation is already running")
    release()
    await expect(first).resolves.toEqual({ enabled: true, version: "1.21.0" })
  })
})
