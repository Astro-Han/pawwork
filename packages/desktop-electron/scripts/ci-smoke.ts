import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import readline from "node:readline"
import { PAWWORK_APP, type PawWorkChannel } from "../src/main/app-identity.ts"
const require = createRequire(import.meta.url)
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export type SmokeChannel = PawWorkChannel
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
  sidebarBrandVisible: boolean
  automationEntryVisible: boolean
  automationSurfaceVisible: boolean
  automationEditorVisible: boolean
  automationMetadataPlain: boolean
  automationBelowNewSession: boolean
  collapsedAutomationBelowNewSession: boolean
  collapsedAutomationChromeMatchesNewSession: boolean
  collapsedAutomationIconMatchesRail: boolean
  collapsedSidebarDividerHiddenOnMac: boolean
  sidebarAutomationCollapseAnimated: boolean
  sidebarAutomationExpandAnimated: boolean
  sidebarToggleCount: number
  sidebarToggleAlignedWithWindowControls: boolean
  sidebarToggleChromeSubtle: boolean
  sidebarCollapsed: boolean
  sidebarExpandToggleCount: number
  sidebarExpandToggleUsable: boolean
  sidebarToggleShift: number
  sidebarExpandedAgain: boolean
  retiredBrandVisible: boolean
  platform: string
  freeProviderActive: boolean
  freeModelAvailable: boolean
  skillNames: string[]
  sessionId: string
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

function parseChannel(raw: string | undefined): SmokeChannel {
  if (raw === undefined || raw === "") return "dev"
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  throw new Error(`Unsupported smoke channel: ${raw}`)
}

export function appIdForSmoke(channel: SmokeChannel, mode: SmokeMode) {
  return PAWWORK_APP[mode === "raw" ? "dev" : channel].id
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
  return resolve(import.meta.dirname, "../out/main/index.js")
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
  const sleep = options.sleep ?? delay
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
  const workspace = JSON.stringify(workspacePath)
  const expression = `(async () => {
    const visible = (element) => {
      if (!element) return false
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current)
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false
      }
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const usable = (element) => {
      if (!visible(element)) return false
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      const hasVisibleContent = element.textContent?.trim()
        || Array.from(element.querySelectorAll("svg, img")).some((child) => visible(child))
      return Boolean(hasVisibleContent) && (hit === element || element.contains(hit))
    }
    const call = async (method, payload) => {
      const request = { type: "client-request", rpcId: crypto.randomUUID(), method, payload }
      const response = await fetch("/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error(method + ": HTTP " + response.status)
      const envelope = await response.json()
      if (!envelope?.result?.ok) throw new Error(method + ": " + (envelope?.result?.error?.message || "unknown failure"))
      return envelope.result.value
    }
    const currentAutomationEntry = () => document.querySelector(".pawwork-automation-entry")
    const automationEntry = currentAutomationEntry()
    const pawworkBrandName = document.querySelector(".pawwork-brand-name")
    const currentNewSession = () => Array.from(document.querySelectorAll("button")).find((button) => {
      const label = button.getAttribute("aria-label") || button.textContent || ""
      return label.includes("New Session") || label.includes("New session") || label.includes("新会话") || label.includes("新建会话")
    })
    const newSession = currentNewSession()
    const sidebarToggles = () => Array.from(document.querySelectorAll("button")).filter((button) => {
      const label = button.getAttribute("aria-label") || button.getAttribute("title") || ""
      return visible(button) && /^(收起侧边栏|打开侧边栏|切换侧边栏|Collapse sidebar|Open sidebar|Toggle sidebar)$/i.test(label)
    })
    const automationRect = automationEntry?.getBoundingClientRect()
    const newSessionRect = newSession?.getBoundingClientRect()
    const sidebarBrandVisible = visible(pawworkBrandName)
    const automationEntryVisible = visible(automationEntry)

    automationEntry?.click()
    let automationRow
    for (let attempt = 0; attempt < 20 && !automationRow; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      automationRow = document.querySelector(".pawwork-automation-row")
    }
    const automationSurfaceVisible = visible(document.querySelector(".pawwork-automations-surface"))
    automationRow?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    Array.from(document.querySelectorAll('button, [role="button"]')).find((element) => {
      const label = element.getAttribute("aria-label") || element.textContent || ""
      return label.includes("Advanced settings") || label.includes("高级设置")
    })?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const readonlyMetadata = Array.from(document.querySelectorAll(".pawwork-automation-readonly"))
    const automationEditorVisible = visible(document.querySelector(".pawwork-automation-panel"))
    const automationMetadataPlain = readonlyMetadata.length === 2
      && document.querySelector(".pawwork-automation-select-trigger[disabled]") === null
    const retiredBrandVisible = Array.from(document.querySelectorAll('svg[viewBox="0 0 182 24"], svg[viewBox="0 0 23.16 17.04"]')).some(visible)
    const collapseToggles = sidebarToggles()
    const collapseRect = collapseToggles[0]?.getBoundingClientRect()
    const collapseStyle = collapseToggles[0] ? getComputedStyle(collapseToggles[0]) : null
    collapseToggles[0]?.click()
    let sidebarAutomationCollapseAnimated = false
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      const collapsedEntry = currentAutomationEntry()
      if (collapsedEntry?.getAttribute("data-wide") !== "false") continue
      const style = getComputedStyle(collapsedEntry)
      sidebarAutomationCollapseAnimated = Number(style.opacity) < 1 || style.transform !== "none"
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sidebarCollapsed = Boolean(document.querySelector("[data-sidebar-collapsed]"))
    const sidebarColumn = document.querySelector("[data-sidebar-collapsed] > :first-child")
    const collapsedAutomationEntry = currentAutomationEntry()
    const collapsedNewSession = currentNewSession()
    const collapsedAutomationRect = collapsedAutomationEntry?.getBoundingClientRect()
    const collapsedNewSessionRect = collapsedNewSession?.getBoundingClientRect()
    const iconVisualSize = (button) => {
      const svg = button?.querySelector("svg")
      if (!svg) return null
      const rect = svg.getBoundingClientRect()
      const box = svg.getBBox()
      const viewBox = svg.viewBox.baseVal
      if (viewBox.width === 0 || viewBox.height === 0) return null
      return { width: box.width * rect.width / viewBox.width, height: box.height * rect.height / viewBox.height }
    }
    const collapsedAutomationIcon = iconVisualSize(collapsedAutomationEntry)
    const collapsedNewSessionIcon = iconVisualSize(collapsedNewSession)
    const collapsedAutomationStyle = collapsedAutomationEntry ? getComputedStyle(collapsedAutomationEntry) : null
    const collapsedNewSessionStyle = collapsedNewSession ? getComputedStyle(collapsedNewSession) : null
    const expandToggles = sidebarToggles()
    const expandRect = expandToggles[0]?.getBoundingClientRect()
    const sidebarExpandToggleUsable = usable(expandToggles[0])
    const sidebarToggleShift = collapseRect && expandRect
      ? Math.hypot(
          collapseRect.left + collapseRect.width / 2 - expandRect.left - expandRect.width / 2,
          collapseRect.top + collapseRect.height / 2 - expandRect.top - expandRect.height / 2,
        )
      : 9_999
    expandToggles[0]?.click()
    await new Promise((resolve) => setTimeout(resolve, 32))
    const expandedAutomationEntry = currentAutomationEntry()
    const sidebarAutomationExpandAnimated = Boolean(
      expandedAutomationEntry && Number(getComputedStyle(expandedAutomationEntry).opacity) < 1,
    )
    await new Promise((resolve) => setTimeout(resolve, 200))

    const providers = (await call("llm.providers", {})).providers
    const models = (await call("llm.models", {})).groups
    const session = await call("session.create", { cwd: ${workspace} })
    const skills = (await call("skill.list", { sessionId: session.sessionId })).skills
    const freeProvider = providers.find((provider) => provider.provider === "opencode")
    const freeModels = models.find((group) => group.id === "opencode")?.models || []
    return JSON.stringify({
      sidebarBrandVisible,
      automationEntryVisible,
      automationSurfaceVisible,
      automationEditorVisible,
      automationMetadataPlain,
      automationBelowNewSession: Boolean(automationRect && newSessionRect && automationRect.top >= newSessionRect.bottom),
      collapsedAutomationBelowNewSession: Boolean(
        collapsedAutomationRect && collapsedNewSessionRect
        && collapsedAutomationRect.top >= collapsedNewSessionRect.bottom,
      ),
      collapsedAutomationChromeMatchesNewSession: Boolean(
        collapsedAutomationRect && collapsedNewSessionRect
        && collapsedAutomationStyle && collapsedNewSessionStyle
        && collapsedAutomationRect.width === collapsedNewSessionRect.width
        && collapsedAutomationRect.height === collapsedNewSessionRect.height
        && collapsedAutomationRect.left + collapsedAutomationRect.width / 2
          === collapsedNewSessionRect.left + collapsedNewSessionRect.width / 2
        && collapsedAutomationStyle.borderRadius === collapsedNewSessionStyle.borderRadius,
      ),
      collapsedAutomationIconMatchesRail: Boolean(
        collapsedAutomationIcon && collapsedNewSessionIcon
        && Math.abs(collapsedAutomationIcon.width - collapsedNewSessionIcon.width) <= 1
        && Math.abs(collapsedAutomationIcon.height - collapsedNewSessionIcon.height) <= 1,
      ),
      collapsedSidebarDividerHiddenOnMac: document.documentElement.dataset.pawworkPlatform !== "macos"
        || Boolean(sidebarColumn && getComputedStyle(sidebarColumn).borderRightWidth === "0px"),
      sidebarAutomationCollapseAnimated,
      sidebarToggleCount: collapseToggles.length,
      sidebarToggleAlignedWithWindowControls: document.documentElement.dataset.pawworkPlatform !== "macos"
        || Boolean(collapseRect && collapseRect.left === 76 && collapseRect.top === 9),
      sidebarToggleChromeSubtle: document.documentElement.dataset.pawworkPlatform !== "macos"
        || Boolean(collapseStyle && collapseStyle.backgroundColor === "rgba(0, 0, 0, 0)" && collapseStyle.borderRadius === "6px"),
      sidebarCollapsed,
      sidebarExpandToggleCount: expandToggles.length,
      sidebarExpandToggleUsable,
      sidebarAutomationExpandAnimated,
      sidebarToggleShift,
      sidebarExpandedAgain: !document.querySelector("[data-sidebar-collapsed]"),
      retiredBrandVisible,
      platform: document.documentElement.dataset.pawworkPlatform || "",
      freeProviderActive: freeProvider?.active === true && freeProvider?.displayName === "OpenCode Free",
      freeModelAvailable: freeModels.some((model) => model.id === "deepseek-v4-flash-free" && model.name === "DeepSeek V4 Flash Free"),
      skillNames: skills.map((skill) => skill.name).sort(),
      sessionId: session.sessionId,
    })
  })()`

  return await evaluateCiSmokeJson(target, expression) as CiSmokeProductSnapshot
}

async function evaluateCiSmokeJson(target: CdpTarget, expression: string) {
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("DSH CDP target does not expose a WebSocket debugger URL")
  }

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
  return JSON.parse(result.result.value) as unknown
}

export async function inspectCiSmokePersistence(target: CdpTarget, sessionId: string) {
  const expectedSessionId = JSON.stringify(sessionId)
  const expression = `(async () => {
    const call = async (method, payload) => {
      const request = { type: "client-request", rpcId: crypto.randomUUID(), method, payload }
      const response = await fetch("/api/" + method, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error(method + ": HTTP " + response.status)
      const envelope = await response.json()
      if (!envelope?.result?.ok) throw new Error(envelope?.result?.error?.message || method + " failed")
      return envelope.result.value
    }
    const sessions = (await call("session.list", {})).items
    return JSON.stringify(sessions.some((session) => session.sessionId === ${expectedSessionId}))
  })()`
  const persisted = await evaluateCiSmokeJson(target, expression)
  if (persisted !== true) throw new Error(`DSH session ${sessionId} did not survive desktop restart`)
}

export function assertCiSmokeProduct(snapshot: CiSmokeProductSnapshot) {
  const failures = [
    !snapshot.sidebarBrandVisible ? null : "sidebar brand should stay out of the macOS titlebar",
    snapshot.automationEntryVisible ? null : "Automation entry is not visible",
    snapshot.automationSurfaceVisible ? null : "Automation surface did not open",
    snapshot.automationEditorVisible ? null : "Automation editor did not open",
    snapshot.automationMetadataPlain ? null : "Automation immutable metadata is not plain read-only text",
    snapshot.automationBelowNewSession ? null : "Automation is not below New Session",
    snapshot.collapsedAutomationBelowNewSession ? null : "collapsed Automation is not below New Session",
    snapshot.collapsedAutomationChromeMatchesNewSession ? null : "collapsed Automation hover shape does not match New Session",
    snapshot.collapsedAutomationIconMatchesRail ? null : "collapsed Automation icon visual weight does not match the sidebar rail",
    snapshot.collapsedSidebarDividerHiddenOnMac ? null : "collapsed macOS sidebar divider crosses the window controls",
    snapshot.sidebarAutomationCollapseAnimated ? null : "Automation does not animate into the collapsed rail",
    snapshot.sidebarToggleCount === 1 ? null : `expected one DSH collapse control, found ${snapshot.sidebarToggleCount}`,
    snapshot.sidebarToggleAlignedWithWindowControls ? null : "sidebar toggle is not aligned with the macOS window controls",
    snapshot.sidebarToggleChromeSubtle ? null : "sidebar toggle chrome does not blend into the titlebar",
    snapshot.sidebarCollapsed ? null : "DSH collapse control did not collapse the sidebar",
    snapshot.sidebarExpandToggleCount === 1 ? null : `expected one DSH expand control, found ${snapshot.sidebarExpandToggleCount}`,
    snapshot.sidebarExpandToggleUsable ? null : "DSH expand control is not visibly clickable",
    snapshot.sidebarAutomationExpandAnimated ? null : "Automation does not animate into the expanded sidebar",
    snapshot.platform !== "macos" || snapshot.sidebarToggleShift <= 1 ? null : `DSH sidebar control moved ${snapshot.sidebarToggleShift.toFixed(1)}px while collapsing`,
    snapshot.sidebarExpandedAgain ? null : "DSH expand control did not reopen the sidebar",
    !snapshot.retiredBrandVisible ? null : "retired DSH branding is visible",
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

    await delay(250)
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
    throw new Error(`Failed to launch desktop app: ${launch.command}: ${message}`)
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill("SIGTERM")
  const result = await Promise.race([once(child, "exit").then(() => "exit"), delay(5_000).then(() => "timeout")])

  if (result === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await once(child, "exit").catch(() => undefined)
  }
}

async function main() {
  const target = parseSmokeArgs(process.argv.slice(2))
  const homeDir = mkdtempSync(join(tmpdir(), "pawwork-ci-smoke-"))
  const dshHome = join(homeDir, appIdForSmoke(target.channel, target.mode), "dsh")
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(dshHome, "automations.json"), `${JSON.stringify({
    schema: 1,
    nextDefinition: 2,
    nextRun: 1,
    definitions: [{
      id: "automation-smoke",
      title: "Smoke automation",
      prompt: "Verify the Automation editor.",
      revision: 1,
      paused: true,
      context: "fresh",
      cwd: homeDir,
      model: { provider: "opencode", model: "deepseek-v4-flash-free" },
      timezone: "UTC",
      createdAt: 1,
      updatedAt: 1,
      kind: "recurring",
      rhythm: { kind: "interval", everyMs: 60_000 },
      stop: { kind: "never" },
      nextFireAt: null,
    }],
    runs: [],
  }, null, 2)}\n`, { mode: 0o600 })
  const cdpPort = await resolveCiSmokeCdpPort(process.env)
  const { child, spawnError } = launchApp(homeDir, target, { cdpPort })
  const logs = watchChildLogs(child)
  let product: CiSmokeProductSnapshot | undefined

  try {
    await waitForCiSmokeReady(homeDir, target, child, spawnError, logs.recent)
    if (cdpPort !== undefined) {
      const cdpTarget = await probeCiSmokeCdpTarget(cdpPort)
      product = await inspectCiSmokeProduct(cdpTarget, homeDir)
      assertCiSmokeProduct(product)
      console.log("CI smoke verified DSH product UI, free model, and bundled skills")
    }
  } finally {
    logs.close()
    await stopChild(child)
  }

  if (product !== undefined) {
    rmSync(resolveCiSmokeReadyFile(homeDir, { channel: target.channel, mode: target.mode }), { force: true })
    const restartPort = await allocateCiSmokeCdpPort()
    const restarted = launchApp(homeDir, target, { cdpPort: restartPort })
    const restartLogs = watchChildLogs(restarted.child)
    try {
      await waitForCiSmokeReady(homeDir, target, restarted.child, restarted.spawnError, restartLogs.recent)
      const restartTarget = await probeCiSmokeCdpTarget(restartPort)
      await inspectCiSmokePersistence(restartTarget, product.sessionId)
      console.log("CI smoke verified DSH session persistence after restart")
    } finally {
      restartLogs.close()
      await stopChild(restarted.child)
    }
  }
}

if (import.meta.main) {
  await main()
}
