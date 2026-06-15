import { spawn as spawnProcess, type SpawnOptions } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { EventEmitter } from "node:events"

import type { ServerReadyData } from "../preload/types"

export const REMOTE_ACCESS_PLATFORMS = [
  "dingtalk",
  "discord",
  "feishu",
  "lark",
  "line",
  "max",
  "qq",
  "qqbot",
  "slack",
  "telegram",
  "wecom",
  "weixin",
  "wps-xiezuo",
] as const

export type RemoteAccessConfig = {
  enabled: boolean
  platform: string
  options: Record<string, unknown>
}

export type RemoteAccessStatus = {
  state: "idle" | "starting" | "running" | "error"
  configured: boolean
  platform: string | null
  platforms: string[]
  lastStartedAt?: string
  lastStoppedAt?: string
  lastError?: string
}

type RemoteBridgeChild = EventEmitter & {
  stdout?: EventEmitter
  stderr?: EventEmitter
  stdin?: {
    end: (data: string) => void
  }
  kill?: () => boolean
}

type SpawnBridge = (command: string, args: string[], options: SpawnOptions) => RemoteBridgeChild

type ControllerDeps = {
  userDataPath: string
  appPath: string
  resourcesPath: string
  isPackaged: boolean
  serverReady: () => Promise<ServerReadyData>
  spawn?: SpawnBridge
  log?: (message: string, data?: Record<string, unknown>) => void
  error?: (message: string, error: unknown) => void
}

const defaultConfig: RemoteAccessConfig = {
  enabled: false,
  platform: "feishu",
  options: {},
}

export function createRemoteBridgeController(deps: ControllerDeps) {
  const spawnBridge = deps.spawn ?? ((command, args, options) => spawnProcess(command, args, options) as RemoteBridgeChild)
  const root = join(deps.userDataPath, "remote-access")
  const userConfigPath = join(root, "config.json")
  const runtimeConfigPath = join(root, "runtime-config.json")
  const statePath = join(root, "sessions.json")
  let child: RemoteBridgeChild | null = null
  let currentState: RemoteAccessStatus["state"] = "idle"
  let currentConfig: RemoteAccessConfig | null = null
  let lastStartedAt: string | undefined
  let lastStoppedAt: string | undefined
  let lastError: string | undefined
  let startToken = 0

  const status = (): RemoteAccessStatus => ({
    state: currentState,
    configured: Boolean(currentConfig?.enabled),
    platform: currentConfig?.platform ?? null,
    platforms: [...REMOTE_ACCESS_PLATFORMS],
    lastStartedAt,
    lastStoppedAt,
    lastError,
  })

  const getConfig = async () => {
    currentConfig = await readUserConfig(userConfigPath)
    return currentConfig
  }

  const saveConfig = async (config: RemoteAccessConfig) => {
    currentConfig = normalizeConfig(config)
    await writeJSON(userConfigPath, currentConfig)
    if (!currentConfig.enabled) {
      startToken++
      await stopChild()
      currentState = "idle"
      lastError = undefined
    }
    return currentConfig
  }

  const start = async (config?: RemoteAccessConfig) => {
    const token = ++startToken
    if (config) await saveConfig(config)
    currentConfig = await readUserConfig(userConfigPath)
    if (!currentConfig.enabled) {
      lastError = "Remote access is disabled."
      currentState = "error"
      return status()
    }
    if (!hasRemoteAudience(currentConfig.platform, currentConfig.options)) {
      lastError =
        "Set a specific allow_from before starting remote access, or set allow_chat with group_only for chat-only Feishu/Lark access."
      currentState = "error"
      return status()
    }
    await stopChild()
    if (token !== startToken) return status()
    currentState = "starting"
    lastError = undefined

    try {
      const server = await deps.serverReady()
      if (token !== startToken) return status()
      const runtimeConfig = {
        pawWorkBaseURL: server.url,
        pawWorkUsername: server.username ?? undefined,
        pawWorkPassword: server.password ?? undefined,
        statePath,
        platforms: [
          {
            name: currentConfig.platform,
            enabled: true,
            options: currentConfig.options,
          },
        ],
      }
      await rm(runtimeConfigPath, { force: true })
      if (token !== startToken) return status()
      const command = resolveBridgeCommand(deps)
      const nextChild = spawnBridge(command.command, [...command.args, "-config", "-"], {
        cwd: command.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      })
      if (!nextChild.stdin) {
        await waitForExitAfterKill(nextChild)
        throw new Error("Remote bridge stdin is unavailable.")
      }
      nextChild.stdin.end(`${JSON.stringify(runtimeConfig)}\n`)
      child = nextChild
      nextChild.stdout?.on("data", (chunk) => deps.log?.("remote bridge stdout", { text: String(chunk) }))
      nextChild.stderr?.on("data", (chunk) => deps.log?.("remote bridge stderr", { text: String(chunk) }))
      const startedChild = nextChild
      nextChild.once("error", (error) => {
        if (child !== startedChild) return
        child = null
        deps.error?.("remote bridge process error", error)
        currentState = "error"
        lastError = error instanceof Error ? error.message : String(error)
      })
      nextChild.once("exit", (code, signal) => {
        if (child !== startedChild) return
        child = null
        lastStoppedAt = new Date().toISOString()
        if (code === 0 || currentState === "idle") {
          currentState = "idle"
          return
        }
        currentState = "error"
        lastError = `Remote bridge exited with ${signal ?? code ?? "unknown"}.`
      })
      currentState = "running"
      lastStartedAt = new Date().toISOString()
    } catch (error) {
      if (token !== startToken) return status()
      deps.error?.("remote bridge start failed", error)
      currentState = "error"
      lastError = error instanceof Error ? error.message : String(error)
    }
    return status()
  }

  const stop = async () => {
    startToken++
    await stopChild()
    currentState = "idle"
    lastError = undefined
    return status()
  }

  const stopChild = async () => {
    const running = child
    child = null
    if (running) {
      await waitForExitAfterKill(running)
      lastStoppedAt = new Date().toISOString()
    }
  }

  return { getConfig, saveConfig, start, stop, status }
}

function waitForExitAfterKill(child: RemoteBridgeChild) {
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.off("exit", done)
      child.off("error", done)
      resolve()
    }
    child.once("exit", done)
    child.once("error", done)
    timer = setTimeout(done, 2000)
    if (!child.kill || child.kill() === false) done()
  })
}

async function readUserConfig(path: string): Promise<RemoteAccessConfig> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    return defaultConfig
  }
  return normalizeConfig(JSON.parse(raw))
}

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function normalizeConfig(value: unknown): RemoteAccessConfig {
  if (!value || typeof value !== "object") return defaultConfig
  const raw = value as Partial<RemoteAccessConfig>
  const platform = typeof raw.platform === "string" && raw.platform ? raw.platform : defaultConfig.platform
  const options: Record<string, unknown> = {}
  if (raw.options && typeof raw.options === "object") {
    for (const [key, option] of Object.entries(raw.options)) {
      const normalized = normalizeOptionValue(option)
      if (normalized !== undefined) options[key] = normalized
    }
  }
  return {
    enabled: raw.enabled === true,
    platform,
    options,
  }
}

function normalizeOptionValue(value: unknown): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value
  if (Array.isArray(value)) return value.map(normalizeOptionValue).filter((item) => item !== undefined)
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const next = normalizeOptionValue(item)
      if (next !== undefined) normalized[key] = next
    }
    return normalized
  }
  return undefined
}

function hasRemoteAudience(platform: string, options: Record<string, unknown>) {
  if (hasSpecificAudience(options.allow_from)) return true
  if (platform !== "feishu" && platform !== "lark") return false
  return hasSpecificAudience(options.allow_chat) && options.group_only === true
}

function hasSpecificAudience(value: unknown) {
  return typeof value === "string" && value.trim() !== "" && value.trim() !== "*"
}

async function writeJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function resolveBridgeCommand(deps: Pick<ControllerDeps, "appPath" | "resourcesPath" | "isPackaged">) {
  const binary = process.platform === "win32" ? "pawwork-remote-bridge.exe" : "pawwork-remote-bridge"
  if (deps.isPackaged) {
    return { command: join(deps.resourcesPath, "tools", binary), args: [] as string[] }
  }
  const source = findRemoteBridgeSourceRoot(deps.appPath)
  const workspaceRoot = dirname(dirname(source))
  const devBinary = join(workspaceRoot, "packages", "desktop-electron", "resources", "tools", binary)
  if (existsSync(devBinary)) {
    return { command: devBinary, args: [] as string[] }
  }
  return { command: "go", args: ["run", "./cmd/pawwork-remote-bridge"], cwd: source }
}

function findRemoteBridgeSourceRoot(start: string) {
  let current = resolve(start)
  for (let index = 0; index < 8; index++) {
    const candidate = join(current, "packages", "remote-bridge")
    if (existsSync(join(candidate, "go.mod"))) return candidate
    current = dirname(current)
  }
  throw new Error("Could not find packages/remote-bridge")
}
