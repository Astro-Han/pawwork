import { describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import {
  allocateCiSmokeCdpPort,
  appIdForSmoke,
  dshHomeForSmoke,
  assertCiSmokeProduct,
  buildSmokeEnv,
  isCiSmokeDshTarget,
  parseSmokeArgs,
  parseSmokeCdpPort,
  probeCiSmokeCdpTarget,
  resolveCiSmokeReadyFile,
  resolveCiSmokeCdpPort,
  resolveLaunchCommand,
  resolveMainEntry,
} from "./ci-smoke"
import type { CiSmokeProductSnapshot } from "./ci-smoke"
import { packagedAppEnv } from "./packaged-app-env.ts"
import type { PawWorkChannel } from "../src/main/app-identity.ts"

describe("ci smoke helpers", () => {
  test("resolveMainEntry points at the built Electron main process bundle", () => {
    expect(resolveMainEntry().endsWith(path.join("packages", "desktop-electron", "out", "main", "index.js"))).toBe(true)
  })

  test("buildSmokeEnv isolates the app state in a temporary home", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke")

    expect(env.PAWWORK_CI_SMOKE).toBe("true")
    expect(env.PAWWORK_CI_SMOKE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_DATA_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_CACHE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_STATE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.CI).toBe("true")
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
    expect(appIdForSmoke("prod", "packaged")).toBe("ai.pawwork.desktop")
  })

  test("dshHomeForSmoke hangs the DSH home off the smoke home, not off its app data directory", () => {
    expect(dshHomeForSmoke("/tmp/smoke", { mode: "raw", channel: "prod" })).toBe(
      path.join("/tmp/smoke", ".pawwork", "dsh-dev"),
    )
  })

  test("resolveCiSmokeReadyFile follows packaged channel app IDs", () => {
    expect(resolveCiSmokeReadyFile("/tmp/pawwork-ci-smoke", { channel: "prod", mode: "packaged" })).toBe(
      path.join("/tmp/pawwork-ci-smoke", "ai.pawwork.desktop", "ci-smoke-ready.json"),
    )
  })

  test("buildSmokeEnv carries the workflow-scoped CDP port into the child process", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke", { PAWWORK_CI_SMOKE_CDP_PORT: "48291" })

    expect(env.PAWWORK_CI_SMOKE_CDP_PORT).toBe("48291")
  })

  test("buildSmokeEnv injects the harness-allocated CDP port into the child process", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke", {}, { cdpPort: 48291 })

    expect(env.PAWWORK_CI_SMOKE_CDP_PORT).toBe("48291")
  })

  test("buildSmokeEnv exposes only the explicit v1 fixture to the importer", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke", {}, { v1Database: "/tmp/v1/pawwork.db" })

    expect(env.PAWWORK_V1_DATABASE).toBe("/tmp/v1/pawwork.db")
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

  test("isCiSmokeDshTarget accepts DSH loopback pages only", () => {
    expect(isCiSmokeDshTarget({ type: "page", url: "http://127.0.0.1:5173/index.html" })).toBe(true)
    expect(isCiSmokeDshTarget({ type: "page", url: "http://localhost:5173/index.html#/chat" })).toBe(true)
    expect(isCiSmokeDshTarget({ type: "page", url: "http://[::1]:5173/index.html?debug=1" })).toBe(true)
    expect(isCiSmokeDshTarget({ type: "page", url: "about:blank" })).toBe(false)
    expect(isCiSmokeDshTarget({ type: "page", url: "devtools://devtools/bundled/inspector.html" })).toBe(false)
    expect(isCiSmokeDshTarget({ type: "iframe", url: "pawwork-renderer://renderer/index.html" })).toBe(false)
    expect(isCiSmokeDshTarget({ type: "page", url: "file:///Applications/PawWork/index.html" })).toBe(false)
    expect(isCiSmokeDshTarget({ type: "page", url: "pawwork-renderer://renderer/index.html" })).toBe(false)
  })

  test("probeCiSmokeCdpTarget retries until the renderer target is discoverable", async () => {
    const calls: string[] = []
    const responses = [
      Promise.reject(new Error("connect ECONNREFUSED")),
      Promise.resolve(new Response(JSON.stringify([{ type: "page", url: "about:blank" }]))),
      Promise.resolve(
        new Response(JSON.stringify([{ type: "page", url: "http://127.0.0.1:53501/" }])),
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
    ).rejects.toThrow("CDP endpoint on port 48291 did not expose a DSH page target")
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

  // A healthy snapshot, and one broken value per field. Asserting on the joined
  // failure prose meant rewording any one message turned the test red while a
  // clause that stopped being evaluated stayed green. What matters is that every
  // field the snapshot carries is actually consulted.
  const healthy: CiSmokeProductSnapshot = {
    sidebarExpandedBrandHidden: true,
    heroMarkVisible: true,
    heroHeadlineOverridden: true,
    heroPreviewBadgeHidden: true,
    heroMarkHeadlineOffset: 0.4,
    automationSettingsEntryVisible: true,
    automationSidebarEntryAbsent: true,
    automationSurfaceVisible: true,
    automationCreateViaChatWorked: true,
    automationEditorVisible: true,
    automationEditorUsesFullWidth: true,
    automationAdvancedVisible: true,
    automationBackNavigationWorks: true,
    automationEditorHeaderFits: true,
    automationSaveWorks: true,
    automationDeleteDialogWorks: true,
    automationDirtyPauseBlocked: true,
    automationMetadataPlain: true,
    cursorMismatches: [],
    cursorProbeCaught: ["a.pawwork-cursor-probe", "button.pawwork-cursor-probe"],
    titlebarStripHeight: 32,
    titlebarStripDraggable: true,
    contentInsetHeight: 0,
    titlebarInsetLeft: 72,
    titlebarInsetRight: 0,
    expandedNativeControlOverlaps: [],
    collapsedNativeControlOverlaps: [],
    sidebarToggleCount: 1,
    sidebarCollapsed: true,
    sidebarExpandToggleCount: 1,
    sidebarExpandToggleUsable: true,
    sidebarExpandToggleHasContent: true,
    sidebarExpandedAgain: true,
    platform: "MacIntel",
    freeProviderActive: true,
    v1SessionImported: true,
    v1SessionVisibleInSidebar: true,
    skillNames: ["office-docx", "office-pdf", "office-pptx", "office-xlsx"],
    sessionId: "session-1",
    sessionIdsBeforeRestart: ["session-1"],
  }

  const broken: Partial<Record<keyof CiSmokeProductSnapshot, unknown>> = {
    sidebarExpandedBrandHidden: false,
    heroMarkVisible: false,
    heroHeadlineOverridden: false,
    heroPreviewBadgeHidden: false,
    heroMarkHeadlineOffset: 4.5,
    automationSettingsEntryVisible: false,
    automationSidebarEntryAbsent: false,
    automationSurfaceVisible: false,
    automationCreateViaChatWorked: false,
    automationEditorVisible: false,
    automationEditorUsesFullWidth: false,
    automationAdvancedVisible: false,
    automationBackNavigationWorks: false,
    automationEditorHeaderFits: false,
    automationSaveWorks: false,
    automationDeleteDialogWorks: false,
    automationDirtyPauseBlocked: false,
    automationMetadataPlain: false,
    cursorMismatches: ["div.CY-8Ka_root"],
    cursorProbeCaught: [],
    titlebarStripHeight: 0,
    titlebarStripDraggable: false,
    contentInsetHeight: 8,
    titlebarInsetLeft: 0,
    titlebarInsetRight: 12,
    expandedNativeControlOverlaps: ["button.collapse"],
    collapsedNativeControlOverlaps: ["button.expand"],
    sidebarToggleCount: 2,
    sidebarCollapsed: false,
    sidebarExpandToggleCount: 0,
    sidebarExpandToggleUsable: false,
    sidebarExpandToggleHasContent: false,
    sidebarExpandedAgain: false,
    freeProviderActive: false,
    v1SessionImported: false,
    v1SessionVisibleInSidebar: false,
    skillNames: ["office-docx"],
  }

  test("accepts a snapshot where every product capability is present", () => {
    expect(() => assertCiSmokeProduct(healthy, "darwin")).not.toThrow()
  })

  test.each(Object.keys(broken))("rejects a snapshot whose %s is wrong", (field) => {
    const key = field as keyof CiSmokeProductSnapshot
    expect(() => assertCiSmokeProduct({ ...healthy, [key]: broken[key] }, "darwin")).toThrow(
      /DSH product smoke failed/,
    )
  })

  test("consults every field it collects", () => {
    // The three left out are carried for the failure report and the restart
    // comparison, not asserted here. A new field landing outside `broken` means
    // the smoke gathers something nothing checks.
    const unchecked = Object.keys(healthy).filter((field) => !(field in broken))
    expect(unchecked.sort()).toEqual(["platform", "sessionId", "sessionIdsBeforeRestart"])
  })

  test("reports every failing capability at once, not just the first", () => {
    // CI reads the thrown message and stops; a check that returned on its first
    // failure would hide the rest until the next run.
    let message = ""
    try {
      assertCiSmokeProduct({ ...healthy, sidebarExpandedBrandHidden: false, freeProviderActive: false }, "darwin")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message.split("\n- ").length - 1).toBe(2)
  })

  test("parseSmokeArgs defaults to raw dev mode", () => {
    expect(parseSmokeArgs([])).toEqual({ mode: "raw", channel: "dev" })
  })

  // The path is derived from the channel now, so these run from a temporary
  // working directory holding the layout electron-builder would have produced.
  function inPackagedTree(channel: PawWorkChannel, build: (executablePath: string) => void, run: () => void) {
    const dir = mkdtempSync(path.join(tmpdir(), "pawwork-ci-smoke-"))
    const previous = process.cwd()
    try {
      process.chdir(dir)
      build(packagedAppEnv(channel).EXECUTABLE_PATH)
      run()
    } finally {
      process.chdir(previous)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // PawWork packages for macOS and Windows only, so the derivation has no answer
  // on the Linux CI runner; packaged-app-env.test.ts covers each platform there.
  const packagesHere = process.platform === "darwin" || process.platform === "win32"

  test.skipIf(!packagesHere)("parseSmokeArgs derives the packaged executable from the channel", () => {
    inPackagedTree(
      "prod",
      (executablePath) => {
        mkdirSync(path.dirname(executablePath), { recursive: true })
        writeFileSync(executablePath, "")
      },
      () => {
        expect(parseSmokeArgs(["packaged", "prod"])).toEqual({
          mode: "packaged",
          channel: "prod",
          executablePath: packagedAppEnv("prod").EXECUTABLE_PATH,
        })
      },
    )
  })

  test.skipIf(!packagesHere)("parseSmokeArgs rejects packaged mode when the derived executable is missing", () => {
    inPackagedTree(
      "dev",
      () => {},
      () => {
        expect(() => parseSmokeArgs(["packaged", "dev"])).toThrow(
          `Packaged smoke executable not found: ${packagedAppEnv("dev").EXECUTABLE_PATH}`,
        )
      },
    )
  })

  test("parseSmokeArgs accepts an installed executable selected by the release workflow", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pawwork-installed-smoke-"))
    const executablePath = path.join(root, "PawWork.exe")
    writeFileSync(executablePath, "", { flag: "w" })
    try {
      expect(parseSmokeArgs(["packaged", "prod", executablePath])).toEqual({
        mode: "packaged",
        channel: "prod",
        executablePath,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolveLaunchCommand uses Electron for raw runs and the app executable for packaged runs", () => {
    expect(resolveLaunchCommand({ mode: "raw", channel: "dev" }).command.toLowerCase()).toContain("electron")

    expect(resolveLaunchCommand({
      mode: "packaged",
      channel: "dev",
      executablePath: "/tmp/PawWork Dev.app/Contents/MacOS/PawWork Dev",
    })).toEqual({
      command: "/tmp/PawWork Dev.app/Contents/MacOS/PawWork Dev",
      args: [],
    })
  })

  // Spawn a directory rather than a file: exec on a directory is EACCES, and
  // existsSync still accepts it, so parseSmokeArgs lets it through to the spawn.
  // macOS only — Linux has no packaged layout to derive, and Windows launch
  // semantics here are unverified while the assertion targets the spawn-error
  // format rather than the platform's.
  test.skipIf(process.platform !== "darwin")(
    "packaged smoke reports spawn failures with launch context",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "pawwork-ci-smoke-"))
      try {
        const executablePath = packagedAppEnv("dev").EXECUTABLE_PATH
        mkdirSync(path.join(dir, executablePath), { recursive: true })

        const result = spawnSync(
          process.execPath,
          [path.join(import.meta.dirname, "ci-smoke.ts"), "packaged", "dev"],
          {
            cwd: dir,
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
