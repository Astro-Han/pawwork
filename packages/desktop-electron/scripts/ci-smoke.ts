import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import readline from "node:readline"
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

type CdpTarget = {
  type?: unknown
  url?: unknown
  webSocketDebuggerUrl?: unknown
}

export type CiSmokeProductSnapshot = {
  title: string
  automationEntryVisible: boolean
  automationSurfaceVisible: boolean
  automationBelowNewSession: boolean
  sidebarToggleVisible: boolean
  sidebarCollapsed: boolean
  retiredBrandVisible: boolean
  platform: string
  sidebarToggleLeft: number
  freeProviderActive: boolean
  freeModelAvailable: boolean
  skillNames: string[]
}

type ProbeOptions = {
  attempts?: number
  delayMs?: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<unknown>
}

type BuildSmokeEnvOptions = {
  cdpPort?: number
}

type LaunchAppOptions = {
  cdpPort?: number
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

export function buildSmokeEnv(
  homeDir: string,
  channel: SmokeChannel = "dev",
  env: NodeJS.ProcessEnv = process.env,
  options: BuildSmokeEnvOptions = {},
) {
  return {
    ...env,
    CI: "true",
    HOME: homeDir,
    PAWWORK_CI_SMOKE: "true",
    PAWWORK_CI_SMOKE_HOME: homeDir,
    XDG_DATA_HOME: homeDir,
    XDG_CACHE_HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    XDG_STATE_HOME: homeDir,
    OPENCODE_CHANNEL: channel,
    ...(options.cdpPort !== undefined ? { PAWWORK_CI_SMOKE_CDP_PORT: String(options.cdpPort) } : {}),
  }
}

export function parseSmokeCdpPort(raw: string | undefined) {
  if (raw === undefined || raw === "") return undefined
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid CI smoke CDP port: ${raw}`)

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid CI smoke CDP port: ${raw}`)
  }
  return port
}

export async function allocateCiSmokeCdpPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a TCP port on 127.0.0.1")))
        return
      }

      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })

    server.on("error", reject)
  })
}

export async function resolveCiSmokeCdpPort(
  env: Partial<Record<string, string | undefined>> = process.env,
  allocate: () => Promise<number> = allocateCiSmokeCdpPort,
) {
  const explicitPort = parseSmokeCdpPort(env.PAWWORK_CI_SMOKE_CDP_PORT)
  if (explicitPort !== undefined) return explicitPort
  if (env.PAWWORK_CI_SMOKE_CDP !== "true") return undefined

  return await allocate()
}

export function isCiSmokeDshTarget(target: CdpTarget) {
  if (target.type !== "page" || typeof target.url !== "string") return false
  if (target.url === "about:blank" || target.url.startsWith("devtools://")) return false

  return target.url.startsWith("http://127.0.0.1:") || target.url.startsWith("http://localhost:") || target.url.startsWith("http://[::1]:")
}

export async function probeCiSmokeCdpTarget(port: number, options: ProbeOptions = {}) {
  const attempts = options.attempts ?? 50
  const delayMs = options.delayMs ?? 200
  const fetcher = options.fetch ?? fetch
  const sleep = options.sleep ?? Bun.sleep
  const url = `http://127.0.0.1:${port}/json/list`
  let lastConnectionError: string | undefined

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url)
      if (!response.ok) {
        lastConnectionError = `HTTP ${response.status}`
        await response.arrayBuffer().catch(() => undefined)
      } else {
        const targets = (await response.json()) as unknown
        const target = Array.isArray(targets) ? targets.find(isCiSmokeDshTarget) : undefined
        if (target) {
          console.log(`CI smoke DSH target discovered on port ${port}`)
          return target as CdpTarget
        }
        lastConnectionError = undefined
      }
    } catch (error) {
      lastConnectionError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < attempts) await sleep(delayMs)
  }

  if (lastConnectionError) {
    throw new Error(`CDP endpoint never came up on port ${port}: ${lastConnectionError}`)
  }
  throw new Error(`CDP endpoint on port ${port} did not expose a DSH page target`)
}

export async function inspectCiSmokeProduct(target: CdpTarget, workspacePath: string) {
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("DSH CDP target does not expose a WebSocket debugger URL")
  }

  const workspace = JSON.stringify(workspacePath)
  const expression = `(async () => {
    const visible = (element) => {
      if (!element) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
    }
    const unwrap = (response, operation) => {
      if (!response?.result?.ok) throw new Error(operation + ": " + (response?.result?.error?.message || "unknown failure"))
      return response.result.value
    }
    const automationEntry = document.querySelector(".pawwork-automation-entry")
    const newSession = Array.from(document.querySelectorAll("button")).find((button) => {
      const label = button.getAttribute("aria-label") || button.textContent || ""
      return label.includes("New Session") || label.includes("New session") || label.includes("新会话") || label.includes("新建会话")
    })
    const sidebarToggle = document.querySelector(".pawwork-sidebar-toggle")
    const automationRect = automationEntry?.getBoundingClientRect()
    const newSessionRect = newSession?.getBoundingClientRect()
    const automationEntryVisible = visible(automationEntry)

    automationEntry?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const automationSurfaceVisible = visible(document.querySelector(".pawwork-automations-surface"))
    const retiredBrandVisible = Array.from(document.querySelectorAll('svg[viewBox="0 0 182 24"], svg[viewBox="0 0 23.16 17.04"]')).some(visible)
    sidebarToggle?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))

    const module = window.__DSH_MODULES__?.loadCache?.get("@deepseek-ai/dsh-client-connection")?.exports
    if (!module?.AbstractApiClient) throw new Error("DSH client connection module is unavailable")
    class Client extends module.AbstractApiClient { doFetch(input, init) { return fetch(input, init) } }
    const client = new Client()
    const providers = unwrap(await client.llm.providers({}), "list providers").providers
    const models = unwrap(await client.llm.models({}), "list models").groups
    const session = unwrap(await client.sessions.create({ cwd: ${workspace} }), "create session")
    const skills = unwrap(await client.skills.list({ sessionId: session.sessionId }), "list skills").skills
    const freeProvider = providers.find((provider) => provider.provider === "opencode")
    const freeModels = models.find((group) => group.id === "opencode")?.models || []
    const toggleRect = sidebarToggle?.getBoundingClientRect()

    return JSON.stringify({
      title: document.title,
      automationEntryVisible,
      automationSurfaceVisible,
      automationBelowNewSession: Boolean(automationRect && newSessionRect && automationRect.top >= newSessionRect.bottom),
      sidebarToggleVisible: visible(sidebarToggle),
      sidebarCollapsed: Boolean(document.querySelector("[data-sidebar-collapsed]")),
      retiredBrandVisible,
      platform: document.documentElement.dataset.pawworkPlatform || "",
      sidebarToggleLeft: toggleRect?.left ?? -1,
      freeProviderActive: freeProvider?.active === true && freeProvider?.displayName === "OpenCode Free",
      freeModelAvailable: freeModels.some((model) => model.id === "deepseek-v4-flash-free" && model.name === "DeepSeek V4 Flash Free"),
      skillNames: skills.map((skill) => skill.name).sort(),
    })
  })()`

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the DSH product CDP evaluation")), 20_000)
    socket.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("Failed to connect to the DSH product CDP target"))
    }, { once: true })
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
    }, { once: true })
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      if (message.id !== 1) return
      clearTimeout(timeout)
      resolve(message)
    })
  }).finally(() => socket.close())

  const result = response.result as { exceptionDetails?: { text?: string }; result?: { value?: unknown; description?: string } } | undefined
  if (result?.exceptionDetails) {
    throw new Error(`DSH product CDP evaluation failed: ${result.result?.description ?? result.exceptionDetails.text ?? "unknown error"}`)
  }
  if (typeof result?.result?.value !== "string") throw new Error("DSH product CDP evaluation returned no snapshot")
  return JSON.parse(result.result.value) as CiSmokeProductSnapshot
}

export function assertCiSmokeProduct(snapshot: CiSmokeProductSnapshot) {
  const failures = [
    snapshot.title === "PawWork" ? null : `document title is ${JSON.stringify(snapshot.title)}`,
    snapshot.automationEntryVisible ? null : "Automation entry is not visible",
    snapshot.automationSurfaceVisible ? null : "Automation surface did not open",
    snapshot.automationBelowNewSession ? null : "Automation is not below New Session",
    snapshot.sidebarToggleVisible ? null : "sidebar toggle is not visible",
    snapshot.sidebarCollapsed ? null : "sidebar toggle did not collapse the sidebar",
    !snapshot.retiredBrandVisible ? null : "retired DSH branding is visible",
    snapshot.platform !== "macos" || snapshot.sidebarToggleLeft >= 70 ? null : "macOS sidebar toggle overlaps window controls",
    snapshot.freeProviderActive ? null : "OpenCode Free provider is not active",
    snapshot.freeModelAvailable ? null : "DeepSeek V4 Flash Free is unavailable",
    ["office-docx", "office-pdf", "office-pptx", "office-xlsx"].every((name) => snapshot.skillNames.includes(name))
      ? null
      : `bundled Office skills are incomplete: ${snapshot.skillNames.join(", ")}`,
  ].filter((failure): failure is string => failure !== null)

  if (failures.length) throw new Error(`DSH product smoke failed:\n- ${failures.join("\n- ")}`)
}

export function resolveCiSmokeReadyFile(homeDir: string, options: { channel?: SmokeChannel; mode?: SmokeMode } = {}) {
  const channel = options.channel ?? "dev"
  const mode = options.mode ?? "raw"
  return join(homeDir, appIdForSmoke(channel, mode), "ci-smoke-ready.json")
}

function resolveElectronBinary() {
  return require("electron/index.js") as string
}

type LaunchCommandOptions = {
  electronBinary?: () => string
}

export function resolveLaunchCommand(target: SmokeTarget, options: LaunchCommandOptions = {}) {
  if (target.mode === "packaged") {
    return { command: target.executablePath, args: [] as string[] }
  }
  return { command: (options.electronBinary ?? resolveElectronBinary)(), args: [resolveMainEntry()] }
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

function launchApp(homeDir: string, target: SmokeTarget, options: LaunchAppOptions = {}): LaunchedApp {
  const launch = resolveLaunchCommand(target)
  const spawnError = { current: undefined as Error | undefined }
  try {
    const child = spawn(launch.command, launch.args, {
      env: buildSmokeEnv(homeDir, target.channel, process.env, { cdpPort: options.cdpPort }),
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
  const cdpPort = await resolveCiSmokeCdpPort(process.env)
  const { child, spawnError } = launchApp(homeDir, target, { cdpPort })
  const logs = watchChildLogs(child)

  try {
    await waitForCiSmokeReady(homeDir, target, child, spawnError, logs.recent)
    if (cdpPort !== undefined) {
      const cdpTarget = await probeCiSmokeCdpTarget(cdpPort)
      const product = await inspectCiSmokeProduct(cdpTarget, homeDir)
      assertCiSmokeProduct(product)
      console.log("CI smoke verified DSH product UI, free model, and bundled skills")
    }
  } finally {
    logs.close()
    await stopChild(child)
  }
}

if (import.meta.main) {
  await main()
}
