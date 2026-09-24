import { workspaceDependencyPaths } from "@deepseek-ai/dsh-tool-workspace-dependencies"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import lock from "../primary-runtime.lock.json"
import { assertOnlyScriptsData, pythonExecutable, sitePackages, targetKey } from "./prepare-primary-runtime"

describe("prepare-primary-runtime", () => {
  test("has a locked interpreter and wheels for every target PawWork ships", () => {
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]] as const) {
      const target = lock.targets[targetKey(platform, arch)]
      expect(target.pythonSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(target.wheels.length).toBeGreaterThan(0)
    }
  })

  test("lays out the interpreter and site-packages where the workspace-dependencies tool reads them", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const expected = workspaceDependencyPaths("/payload", {
        desktopVersion: "0",
        platform,
        arch: "x64",
        python: lock.pythonVersion,
        pythonPackages: {},
      })
      expect(pythonExecutable("/payload", platform)).toBe(expected.python)
      expect(sitePackages("/payload", platform)).toBe(expected.pythonPackages)
    }
  })

  test("rejects a wheel that installs outside site-packages", async () => {
    const site = mkdtempSync(join(tmpdir(), "site-"))
    mkdirSync(join(site, "tool-1.0.data", "scripts"), { recursive: true })
    await expect(assertOnlyScriptsData(site)).resolves.toBeUndefined()

    mkdirSync(join(site, "tool-1.0.data", "headers"))
    await expect(assertOnlyScriptsData(site)).rejects.toThrow(/headers/)
  })
})
