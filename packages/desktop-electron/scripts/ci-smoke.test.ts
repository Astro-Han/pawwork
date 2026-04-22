import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { desktopShellMainSelector, titlebarShellSelector } from "../src/renderer/ci-smoke-selectors"
import {
  appIdForSmoke,
  buildSmokeEnv,
  parseSmokeArgs,
  requiredSelectors,
  resolveCiSmokeReadyFile,
  resolveLaunchCommand,
  resolveMainEntry,
} from "./ci-smoke"

describe("ci smoke helpers", () => {
  test("resolveMainEntry points at the built Electron main process bundle", () => {
    expect(resolveMainEntry().endsWith(path.join("packages", "desktop-electron", "out", "main", "index.js"))).toBe(true)
  })

  test("buildSmokeEnv isolates the app state in a temporary home", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke")

    expect(env.OPENCODE_CHANNEL).toBe("dev")
    expect(env.PAWWORK_CI_SMOKE).toBe("true")
    expect(env.PAWWORK_CI_SMOKE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_DATA_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_CACHE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_STATE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.CI).toBe("true")
  })

  test("required selectors lock one real renderer affordance", () => {
    expect(requiredSelectors).toEqual([titlebarShellSelector, desktopShellMainSelector])
  })

  test("resolveCiSmokeReadyFile points at the CI-ready marker inside the isolated user data dir", () => {
    expect(resolveCiSmokeReadyFile("/tmp/pawwork-ci-smoke")).toBe(
      path.join("/tmp/pawwork-ci-smoke", "ai.pawwork.desktop.dev", "ci-smoke-ready.json"),
    )
  })

  test("appIdForSmoke uses dev app data for raw runs and channel app IDs for packaged runs", () => {
    expect(appIdForSmoke("dev", "raw")).toBe("ai.pawwork.desktop.dev")
    expect(appIdForSmoke("prod", "raw")).toBe("ai.pawwork.desktop.dev")
    expect(appIdForSmoke("dev", "packaged")).toBe("ai.pawwork.desktop.dev")
    expect(appIdForSmoke("beta", "packaged")).toBe("ai.pawwork.desktop.beta")
    expect(appIdForSmoke("prod", "packaged")).toBe("ai.pawwork.desktop")
  })

  test("resolveCiSmokeReadyFile follows packaged channel app IDs", () => {
    expect(resolveCiSmokeReadyFile("/tmp/pawwork-ci-smoke", { channel: "prod", mode: "packaged" })).toBe(
      path.join("/tmp/pawwork-ci-smoke", "ai.pawwork.desktop", "ci-smoke-ready.json"),
    )
    expect(resolveCiSmokeReadyFile("/tmp/pawwork-ci-smoke", { channel: "beta", mode: "packaged" })).toBe(
      path.join("/tmp/pawwork-ci-smoke", "ai.pawwork.desktop.beta", "ci-smoke-ready.json"),
    )
  })

  test("buildSmokeEnv carries the requested channel into the child process", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke", "prod")

    expect(env.OPENCODE_CHANNEL).toBe("prod")
    expect(env.PAWWORK_CI_SMOKE).toBe("true")
    expect(env.PAWWORK_CI_SMOKE_HOME).toBe("/tmp/pawwork-ci-smoke")
  })

  test("parseSmokeArgs defaults to raw dev mode", () => {
    expect(parseSmokeArgs([])).toEqual({ mode: "raw", channel: "dev" })
  })

  test("parseSmokeArgs accepts a packaged executable path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pawwork-ci-smoke-"))
    try {
      const executablePath = path.join(dir, "PawWork")
      writeFileSync(executablePath, "")

      expect(parseSmokeArgs(["packaged", "prod", executablePath])).toEqual({
        mode: "packaged",
        channel: "prod",
        executablePath,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("parseSmokeArgs rejects packaged mode without an executable path", () => {
    expect(() => parseSmokeArgs(["packaged", "dev"])).toThrow("Packaged smoke requires an executable path")
  })

  test("parseSmokeArgs rejects packaged mode when the executable path is missing", () => {
    expect(() => parseSmokeArgs(["packaged", "dev", "/tmp/pawwork-missing-executable"])).toThrow(
      "Packaged smoke executable not found: /tmp/pawwork-missing-executable",
    )
  })

  test("resolveLaunchCommand uses Electron for raw runs and the app executable for packaged runs", () => {
    const raw = resolveLaunchCommand({ mode: "raw", channel: "dev" })
    expect(raw.args).toEqual([resolveMainEntry()])
    expect(raw.command).toContain("electron")

    const packaged = resolveLaunchCommand({
      mode: "packaged",
      channel: "dev",
      executablePath: "/tmp/PawWork Dev.app/Contents/MacOS/PawWork Dev",
    })
    expect(packaged).toEqual({
      command: "/tmp/PawWork Dev.app/Contents/MacOS/PawWork Dev",
      args: [],
    })
  })

  test("packaged smoke reports spawn failures with launch context", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pawwork-ci-smoke-"))
    try {
      const executablePath = path.join(dir, "PawWork")
      writeFileSync(executablePath, "")
      chmodSync(executablePath, 0o755)

      const result = spawnSync(
        process.execPath,
        [path.join(import.meta.dir, "ci-smoke.ts"), "packaged", "dev", executablePath],
        {
          encoding: "utf8",
          timeout: 5_000,
        },
      )

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain("Failed to launch desktop app:")
      expect(`${result.stdout}${result.stderr}`).toContain(executablePath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
