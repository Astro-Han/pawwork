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

export type SmokeChannel = "dev" | "beta" | "prod"
export type SmokeMode = "raw" | "packaged"

export type SmokeTarget =
  | { mode: "raw"; channel: SmokeChannel }
  | { mode: "packaged"; channel: SmokeChannel; executablePath: string }

type LaunchedApp = {
  child: ChildProcessWithoutNullStreams
  spawnError: { current: Error | undefined }
}

const APP_ID_BY_CHANNEL: Record<SmokeChannel, string> = {
  dev: "ai.pawwork.desktop.dev",
  beta: "ai.pawwork.desktop.beta",
  prod: "ai.pawwork.desktop",
}

function parseChannel(raw: string | undefined): SmokeChannel {
  if (raw === undefined || raw === "") return "dev"
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  throw new Error(`Unsupported smoke channel: ${raw}`)
}

export function appIdForSmoke(channel: SmokeChannel, mode: SmokeMode) {
  if (mode === "raw") return APP_ID_BY_CHANNEL.dev
  return APP_ID_BY_CHANNEL[channel]
}

export function parseSmokeArgs(argv: string[]): SmokeTarget {
  const mode = argv[0] as SmokeMode | undefined
  if (mode === undefined || mode === "raw") {
    return { mode: "raw", channel: parseChannel(argv[1]) }
  }
  if (mode !== "packaged") throw new Error(`Unsupported smoke mode: ${mode}`)

  const executablePath = argv[2]
  if (!executablePath) throw new Error("Packaged smoke requires an executable path")
  if (!existsSync(executablePath)) throw new Error(`Packaged smoke executable not found: ${executablePath}`)
  return { mode, channel: parseChannel(argv[1]), executablePath }
}

export function resolveMainEntry() {
  return resolve(import.meta.dir, "../out/main/index.js")
}

export function buildSmokeEnv(homeDir: string, channel: SmokeChannel = "dev") {
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
    OPENCODE_CHANNEL: channel,
  }
}

export function resolveCiSmokeReadyFile(homeDir: string, options: { channel?: SmokeChannel; mode?: SmokeMode } = {}) {
  const channel = options.channel ?? "dev"
  const mode = options.mode ?? "raw"
  return join(homeDir, appIdForSmoke(channel, mode), "ci-smoke-ready.json")
}

function resolveElectronBinary() {
  return require("electron/index.js") as string
}

export function resolveLaunchCommand(target: SmokeTarget) {
  if (target.mode === "packaged") {
    return { command: target.executablePath, args: [] as string[] }
  }
  return { command: resolveElectronBinary(), args: [resolveMainEntry()] }
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

async function waitForCiSmokeReady(
  homeDir: string,
  target: SmokeTarget,
  child: ChildProcessWithoutNullStreams,
  spawnError: { current: Error | undefined },
  recent: string[],
) {
  const readyFile = resolveCiSmokeReadyFile(homeDir, { channel: target.channel, mode: target.mode })
  const timeoutAt = Date.now() + 60_000

  while (Date.now() < timeoutAt) {
    if (spawnError.current) throw new Error(`Failed to launch desktop app: ${spawnError.current.message}`)
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

function launchApp(homeDir: string, target: SmokeTarget): LaunchedApp {
  const launch = resolveLaunchCommand(target)
  const spawnError = { current: undefined as Error | undefined }
  try {
    const child = spawn(launch.command, launch.args, {
      env: buildSmokeEnv(homeDir, target.channel),
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.on("error", (error) => {
      spawnError.current = error
    })
    return { child, spawnError }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to launch desktop app: ${message}`)
  }
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
  const target = parseSmokeArgs(Bun.argv.slice(2))
  const homeDir = mkdtempSync(join(tmpdir(), "pawwork-ci-smoke-"))
  const { child, spawnError } = launchApp(homeDir, target)
  const logs = watchChildLogs(child)

  try {
    await waitForCiSmokeReady(homeDir, target, child, spawnError, logs.recent)
  } finally {
    logs.close()
    await stopChild(child)
  }
}

if (import.meta.main) {
  await main()
}
