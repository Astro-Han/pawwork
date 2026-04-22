import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import readline from "node:readline"
import { desktopShellMainSelector, titlebarShellSelector } from "../src/renderer/ci-smoke-selectors"

export const requiredSelectors = [titlebarShellSelector, desktopShellMainSelector]
const require = createRequire(import.meta.url)

export function resolveMainEntry() {
  return resolve(import.meta.dir, "../out/main/index.js")
}

export function buildSmokeEnv(homeDir: string) {
  return {
    ...process.env,
    CI: "true",
    HOME: homeDir,
    PAWWORK_CI_SMOKE: "true",
    PAWWORK_CI_SMOKE_HOME: homeDir,
    XDG_DATA_HOME: homeDir,
    XDG_CACHE_HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    XDG_STATE_HOME: homeDir,
    OPENCODE_CHANNEL: "dev",
  }
}

export function resolveCiSmokeReadyFile(homeDir: string) {
  return join(homeDir, "ai.pawwork.desktop.dev", "ci-smoke-ready.json")
}

function resolveElectronBinary() {
  return require("electron/index.js") as string
}

function watchChildLogs(child: ChildProcessWithoutNullStreams) {
  const stdout = readline.createInterface({ input: child.stdout })
  const stderr = readline.createInterface({ input: child.stderr })
  const recent: string[] = []

  const remember = (line: string) => {
    recent.push(line)
    if (recent.length > 40) recent.shift()
  }

  stdout.on("line", remember)
  stderr.on("line", remember)

  return {
    recent,
    close() {
      stdout.close()
      stderr.close()
    },
  }
}

async function waitForCiSmokeReady(homeDir: string, child: ChildProcessWithoutNullStreams, recent: string[]) {
  const readyFile = resolveCiSmokeReadyFile(homeDir)
  const timeoutAt = Date.now() + 60_000

  while (Date.now() < timeoutAt) {
    if (existsSync(readyFile)) return

    if (child.exitCode !== null || child.signalCode !== null) {
      const tail = recent.length ? `\nRecent app output:\n${recent.join("\n")}` : ""
      throw new Error(`Electron exited before reporting CI smoke readiness${tail}`)
    }

    await Bun.sleep(250)
  }

  const tail = recent.length ? `\nRecent app output:\n${recent.join("\n")}` : ""
  throw new Error(`Timed out waiting for the desktop app to report CI smoke readiness${tail}`)
}

function launchApp(homeDir: string) {
  return spawn(resolveElectronBinary(), [resolveMainEntry()], {
    env: buildSmokeEnv(homeDir),
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill("SIGTERM")
  const result = await Promise.race([once(child, "exit").then(() => "exit"), Bun.sleep(5_000).then(() => "timeout")])

  if (result === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await once(child, "exit").catch(() => undefined)
  }
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), "pawwork-ci-smoke-"))
  const child = launchApp(homeDir)
  const logs = watchChildLogs(child)

  try {
    await waitForCiSmokeReady(homeDir, child, logs.recent)
  } finally {
    logs.close()
    await stopChild(child)
  }
}

if (import.meta.main) {
  await main()
}
