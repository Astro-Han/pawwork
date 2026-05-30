import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { desktopShellMainSelector, titlebarShellSelector } from "../src/renderer/ci-smoke-selectors"
import {
  allocateCiSmokeCdpPort,
  appIdForSmoke,
  buildSmokeEnv,
  isCiSmokeRendererTarget,
  parseSmokeArgs,
  parseSmokeCdpPort,
  probeCiSmokeCdpTarget,
  requiredSelectors,
  resolveCiSmokeReadyFile,
  resolveCiSmokeCdpPort,
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

  test("buildSmokeEnv carries the workflow-scoped CDP port into the child process", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke", "dev", { PAWWORK_CI_SMOKE_CDP_PORT: "48291" })

    expect(env.PAWWORK_CI_SMOKE_CDP_PORT).toBe("48291")
  })

  test("buildSmokeEnv injects the harness-allocated CDP port into the child process", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke", "dev", {}, { cdpPort: 48291 })

    expect(env.PAWWORK_CI_SMOKE_CDP_PORT).toBe("48291")
  })

  test("parseSmokeCdpPort accepts only concrete TCP ports", () => {
    expect(parseSmokeCdpPort("48291")).toBe(48291)
    expect(parseSmokeCdpPort(undefined)).toBeUndefined()
    expect(parseSmokeCdpPort("")).toBeUndefined()

    for (const value of ["0", "65536", "1.5", "not-a-port"]) {
      expect(() => parseSmokeCdpPort(value)).toThrow("Invalid CI smoke CDP port")
    }
  })

  test("resolveCiSmokeCdpPort allocates a port only when the CDP probe is enabled", async () => {
    const allocated: string[] = []

    expect(await resolveCiSmokeCdpPort({}, async () => 48291)).toBeUndefined()
    expect(
      await resolveCiSmokeCdpPort({ PAWWORK_CI_SMOKE_CDP: "true" }, async () => {
        allocated.push("called")
        return 48291
      }),
    ).toBe(48291)
    expect(allocated).toEqual(["called"])
  })

  test("resolveCiSmokeCdpPort prefers an explicit port for local smoke debugging", async () => {
    expect(
      await resolveCiSmokeCdpPort({ PAWWORK_CI_SMOKE_CDP: "true", PAWWORK_CI_SMOKE_CDP_PORT: "48291" }, async () => {
        throw new Error("explicit ports should not allocate")
      }),
    ).toBe(48291)
  })

  test("allocateCiSmokeCdpPort returns a concrete loopback TCP port", async () => {
    const port = await allocateCiSmokeCdpPort()

    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
  })

  test("isCiSmokeRendererTarget accepts real renderer page URLs only", () => {
    expect(isCiSmokeRendererTarget({ type: "page", url: "http://127.0.0.1:5173/index.html" })).toBe(true)
    expect(isCiSmokeRendererTarget({ type: "page", url: "http://localhost:5173/index.html#/chat" })).toBe(true)
    expect(isCiSmokeRendererTarget({ type: "page", url: "http://[::1]:5173/index.html?debug=1" })).toBe(true)
    expect(isCiSmokeRendererTarget({ type: "page", url: "pawwork-renderer://renderer/index.html#/session" })).toBe(true)

    expect(isCiSmokeRendererTarget({ type: "page", url: "about:blank" })).toBe(false)
    expect(isCiSmokeRendererTarget({ type: "page", url: "devtools://devtools/bundled/inspector.html" })).toBe(false)
    expect(isCiSmokeRendererTarget({ type: "iframe", url: "pawwork-renderer://renderer/index.html" })).toBe(false)
    expect(isCiSmokeRendererTarget({ type: "page", url: "file:///Applications/PawWork/index.html" })).toBe(false)
    expect(isCiSmokeRendererTarget({ type: "page", url: "pawwork-renderer://wrong/index.html" })).toBe(false)
  })

  test("probeCiSmokeCdpTarget retries until the renderer target is discoverable", async () => {
    const calls: string[] = []
    const responses = [
      Promise.reject(new Error("connect ECONNREFUSED")),
      Promise.resolve(new Response(JSON.stringify([{ type: "page", url: "about:blank" }]))),
      Promise.resolve(
        new Response(JSON.stringify([{ type: "page", url: "pawwork-renderer://renderer/index.html" }])),
      ),
    ]

    await probeCiSmokeCdpTarget(48291, {
      attempts: 3,
      delayMs: 1,
      fetch: (url) => {
        calls.push(url)
        return responses.shift()!
      },
      sleep: () => Promise.resolve(),
    })

    expect(calls).toEqual([
      "http://127.0.0.1:48291/json/list",
      "http://127.0.0.1:48291/json/list",
      "http://127.0.0.1:48291/json/list",
    ])
  })

  test("probeCiSmokeCdpTarget fails clearly when no renderer page appears", async () => {
    await expect(
      probeCiSmokeCdpTarget(48291, {
        attempts: 2,
        delayMs: 1,
        fetch: () => Promise.resolve(new Response(JSON.stringify([{ type: "page", url: "about:blank" }]))),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("CDP endpoint on port 48291 did not expose a renderer page target")
  })

  test("probeCiSmokeCdpTarget drains non-OK discovery responses before retrying", async () => {
    let drained = false

    await expect(
      probeCiSmokeCdpTarget(48291, {
        attempts: 1,
        delayMs: 1,
        fetch: () =>
          Promise.resolve({
            ok: false,
            status: 403,
            arrayBuffer: () => {
              drained = true
              return Promise.resolve(new ArrayBuffer(0))
            },
          } as Response),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("CDP endpoint never came up on port 48291: HTTP 403")

    expect(drained).toBe(true)
  })

  test("probeCiSmokeCdpTarget fails clearly when the endpoint never responds", async () => {
    await expect(
      probeCiSmokeCdpTarget(48291, {
        attempts: 2,
        delayMs: 1,
        fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("CDP endpoint never came up on port 48291")
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
    const raw = resolveLaunchCommand(
      { mode: "raw", channel: "dev" },
      { electronBinary: () => "/tmp/pawwork-electron/electron" },
    )
    expect(raw.args).toEqual([resolveMainEntry()])
    expect(raw.command).toBe("/tmp/pawwork-electron/electron")

    const packaged = resolveLaunchCommand(
      {
        mode: "packaged",
        channel: "dev",
        executablePath: "/tmp/PawWork Dev.app/Contents/MacOS/PawWork Dev",
      },
      {
        electronBinary: () => {
          throw new Error("packaged mode should not resolve electron binary")
        },
      },
    )
    expect(packaged).toEqual({
      command: "/tmp/PawWork Dev.app/Contents/MacOS/PawWork Dev",
      args: [],
    })
  })

  // POSIX-only: the fixture relies on creating an empty file with chmod 0o755
  // to trigger an ENOEXEC spawn error so ci-smoke.ts emits the
  // "Failed to launch desktop app:" branch. Windows has no direct equivalent
  // (empty files run through cmd exit cleanly, sending the flow through the
  // "Electron exited" branch instead), and the assertion targets the spawn
  // error format itself, not Windows-specific launch behavior.
  test.skipIf(process.platform === "win32")(
    "packaged smoke reports spawn failures with launch context",
    () => {
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
    },
  )
})
