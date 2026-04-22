import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { serializeAppUpdateConfig, writeAppUpdateConfig } from "./write-app-update-config"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("write-app-update-config", () => {
  test("serializes prod GitHub updater config", () => {
    expect(
      serializeAppUpdateConfig({
        provider: "github",
        owner: "Astro-Han",
        repo: "pawwork",
        channel: "latest",
      }),
    ).toBe(
      [
        "provider: github",
        "owner: Astro-Han",
        "repo: pawwork",
        "channel: latest",
        "updaterCacheDirName: pawwork-updater",
        "",
      ].join("\n"),
    )
  })

  test("serializes beta GitHub updater config", () => {
    expect(
      serializeAppUpdateConfig({
        provider: "github",
        owner: "Astro-Han",
        repo: "pawwork-beta",
        channel: "latest",
      }),
    ).toContain("repo: pawwork-beta")
  })

  test("does not write updater config without publish config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-app-update-"))
    roots.push(root)

    expect(await writeAppUpdateConfig(join(root, "Resources"), undefined)).toBe(false)
    expect(existsSync(join(root, "Resources", "app-update.yml"))).toBe(false)
  })

  test("writes updater config inside macOS app resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-app-update-"))
    roots.push(root)

    expect(
      await writeAppUpdateConfig(join(root, "PawWork.app", "Contents", "Resources"), {
        provider: "github",
        owner: "Astro-Han",
        repo: "pawwork",
        channel: "latest",
      }),
    ).toBe(true)

    const configPath = join(root, "PawWork.app", "Contents", "Resources", "app-update.yml")
    expect(readFileSync(configPath, "utf8")).toContain("repo: pawwork")
    expect(readFileSync(configPath, "utf8")).toContain("updaterCacheDirName: pawwork-updater")
  })
})
