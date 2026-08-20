import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import readline from "node:readline"
import { PAWWORK_APP, type PawWorkChannel } from "../src/main/app-identity.ts"
import { titlebarHeight } from "../src/main/window-chrome.ts"
import { dshTitleBarOptions } from "../src/main/window-options.ts"
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
  heroMarkVisible: boolean
  heroHeadlineOverridden: boolean
  heroPreviewBadgeHidden: boolean
  heroMarkHeadlineOffset: number
  automationSettingsEntryVisible: boolean
  automationSidebarEntryAbsent: boolean
  automationSurfaceVisible: boolean
  automationCreateViaChatWorked: boolean
  automationEditorVisible: boolean
  automationEditorUsesFullWidth: boolean
  automationAdvancedVisible: boolean
  automationBackNavigationWorks: boolean
  automationEditorHeaderFits: boolean
  automationSaveWorks: boolean
  automationDeleteDialogWorks: boolean
  automationDirtyPauseBlocked: boolean
  automationMetadataPlain: boolean
  titlebarStripHeight: number
  titlebarStripDraggable: boolean
  contentInsetHeight: number
  sidebarBrandTop: number
  sidebarToggleCount: number
  sidebarCollapsed: boolean
  sidebarExpandToggleCount: number
  sidebarExpandToggleUsable: boolean
  sidebarExpandToggleHasContent: boolean
  sidebarExpandedAgain: boolean
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
    const visibleButton = (pattern) => Array.from(document.querySelectorAll("button")).find((button) => {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim()
      return visible(button) && pattern.test(label)
    })
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
    await call("workspace.create", { path: ${workspace} })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const slotContent = (slot) => Array.from(document.querySelectorAll('[data-slot="' + slot + '"] *'))
    const sidebarToggles = () => Array.from(document.querySelectorAll("button")).filter((button) => {
      const label = button.getAttribute("aria-label") || button.getAttribute("title") || ""
      return visible(button) && /^(收起侧边栏|打开侧边栏|切换侧边栏|Collapse sidebar|Open sidebar|Toggle sidebar)$/i.test(label)
    })
    const brandNodes = ["sidebar.brand.mark", "sidebar.brand.name"].flatMap(slotContent).filter(visible)
    const sidebarBrandVisible = brandNodes.length > 0
    const sidebarBrandTop = Math.min(...brandNodes.map((node) => node.getBoundingClientRect().top))
    const titlebarStrip = document.querySelector(".pawwork-titlebar")
    const titlebarStripHeight = titlebarStrip ? titlebarStrip.getBoundingClientRect().height : -1
    const titlebarStripDraggable = Boolean(titlebarStrip)
      && getComputedStyle(titlebarStrip).getPropertyValue("-webkit-app-region").trim() === "drag"
    const appRoot = document.getElementById("root")
    const contentInsetHeight = appRoot ? Number.parseFloat(getComputedStyle(appRoot).paddingTop) : -1
    // Hero 是品牌标识唯一的落点：mark、覆盖后的标题、以及被隐藏的 DSH「预览版」角标。
    // 只断言覆盖机制是否还在生效，不锁死具体文案 —— rc.7→rc.8 悄悄失效的正是机制。
    const heroMark = document.querySelector('[data-slot="conversation.hero.brand.mark"] > svg')
    const heroHeadline = heroMark?.parentElement?.parentElement?.nextElementSibling
    const heroBadge = heroHeadline?.nextElementSibling
    const heroMarkVisible = visible(heroMark)
    const heroHeadlineOverridden = Boolean(heroHeadline)
      && getComputedStyle(heroHeadline).fontSize === "0px"
      && getComputedStyle(heroHeadline, "::before").content.replace(/^"|"$/g, "").trim().length > 0
    const heroPreviewBadgeHidden = !visible(heroBadge)
    const heroMarkRect = heroMark?.getBoundingClientRect()
    const heroHeadlineRect = heroHeadline?.getBoundingClientRect()
    const heroMarkHeadlineOffset = heroMarkRect && heroHeadlineRect
      ? Math.abs((heroMarkRect.top + heroMarkRect.height / 2) - (heroHeadlineRect.top + heroHeadlineRect.height / 2))
      : Number.NaN
    const automationSidebarEntryAbsent = !Array.from(document.querySelectorAll("button")).some((button) => {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim()
      return visible(button) && /^(自动化|Automations)$/i.test(label)
    })
    const settingsTrigger = visibleButton(/^(设置|Settings)$/i)
    settingsTrigger?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const automationSettingsEntry = visibleButton(/^(自动化|Automations)$/i)
    const automationSettingsEntryVisible = visible(automationSettingsEntry)
    automationSettingsEntry?.click()
    for (let attempt = 0; attempt < 20 && !visible(document.querySelector(".pawwork-automations-surface")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const automationSurfaceVisible = visible(document.querySelector(".pawwork-automations-surface"))
    visibleButton(/^(在对话中创建|Create in chat)$/i)?.click()
    let automationCreateViaChatWorked = false
    for (let attempt = 0; attempt < 40 && !automationCreateViaChatWorked; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const draft = Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"]')).find((element) => {
        const content = "value" in element ? element.value : element.textContent || ""
        return visible(element) && /创建一个自动化|create an automation/i.test(content)
      })
      automationCreateViaChatWorked = !visible(document.querySelector(".pawwork-automations-surface")) && Boolean(draft)
    }
    visibleButton(/^(设置|Settings)$/i)?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    visibleButton(/^(自动化|Automations)$/i)?.click()
    let automationRow
    for (let attempt = 0; attempt < 20 && !automationRow; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      automationRow = document.querySelector(".pawwork-automation-row")
    }
    automationRow?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const advancedButton = Array.from(document.querySelectorAll('button, [role="button"]')).find((element) => {
      const label = element.getAttribute("aria-label") || element.textContent || ""
      return label.includes("Advanced settings") || label.includes("高级设置")
    })
    advancedButton?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const automationAdvancedVisible = visible(document.querySelector(".pawwork-automation-advanced-content"))
    const readonlyMetadata = Array.from(document.querySelectorAll(".pawwork-automation-readonly"))
    const automationSurface = document.querySelector(".pawwork-automations-surface")
    const automationEditor = document.querySelector(".pawwork-automation-panel")
    const automationHeader = document.querySelector(".pawwork-automation-panel-head")
    const automationTextarea = document.querySelector(".pawwork-automation-textarea")
    const automationEditorVisible = visible(automationEditor)
    const automationEditorHeaderFits = Boolean(automationHeader && automationHeader.scrollWidth <= automationHeader.clientWidth)
    const surfaceRect = automationSurface?.getBoundingClientRect()
    const editorRect = automationEditor?.getBoundingClientRect()
    const textareaRect = automationTextarea?.getBoundingClientRect()
    const automationEditorUsesFullWidth = Boolean(
      surfaceRect && editorRect && textareaRect
      && editorRect.width >= surfaceRect.width - 1
      && visible(automationTextarea)
      && textareaRect.width >= surfaceRect.width - 64,
    )
    const automationMetadataPlain = readonlyMetadata.length === 2
      && document.querySelector(".pawwork-automation-select-trigger[disabled]") === null
    const titleInput = document.querySelector('.pawwork-automation-input input')
    if (titleInput) {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(titleInput, 'Smoke automation updated')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
      titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const pauseButton = visibleButton(/^(暂停|启用|Pause|Resume)$/i)
    const automationDirtyPauseBlocked = pauseButton?.disabled === true
    visibleButton(/^(保存|Save)$/i)?.click()
    let automationSaveWorks = false
    for (let attempt = 0; attempt < 20 && !automationSaveWorks; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      automationSaveWorks = document.querySelector('.pawwork-automation-panel-head h2')?.textContent === 'Smoke automation updated'
    }
    visibleButton(/^(删除|Delete)$/i)?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const deleteDialog = document.querySelector('[role="dialog"][aria-label="删除自动化？"], [role="dialog"][aria-label="Delete automation?"]')
    const deleteDialogVisible = visible(deleteDialog)
    const cancelDelete = Array.from(deleteDialog?.querySelectorAll('button') || []).find((button) => /^(取消|Cancel)$/i.test((button.textContent || '').trim()))
    cancelDelete?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const automationDeleteDialogWorks = deleteDialogVisible && !visible(deleteDialog)
    visibleButton(/^(返回自动化|Back to Automations)$/i)?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const automationBackNavigationWorks = !visible(document.querySelector(".pawwork-automation-panel"))
      && visible(document.querySelector(".pawwork-automation-row"))
    const settingsClose = Array.from(document.querySelectorAll("button")).find((button) => {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim()
      return visible(button) && /^(关闭|Close)$/i.test(label) && !button.closest(".pawwork-automation-panel")
    })
    settingsClose?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const collapseToggles = sidebarToggles()
    collapseToggles[0]?.click()
    // 折叠轨道是重新挂载的，data-sidebar-collapsed 会先于按钮出现；等按钮真正
    // 就位再量，否则慢一点的机器上量到的是过渡中的空态。空壳按钮仍然有 36×36
    // 的盒子，所以这个循环不会替真正的缺陷兜底 —— 那条由 hasContent 单独盯。
    let expandToggles = []
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      expandToggles = sidebarToggles()
      if (document.querySelector("[data-sidebar-collapsed]") && expandToggles.length > 0) break
    }
    const sidebarCollapsed = Boolean(document.querySelector("[data-sidebar-collapsed]"))
    const sidebarExpandToggleUsable = usable(expandToggles[0])
    // 折叠态下 DSH 把品牌 mark 当作展开按钮的图标，悬停才换成面板图标。品牌槽位
    // 一旦留空，这颗按钮就是个看不见的空壳 —— 这里盯的就是那种空壳。
    const sidebarExpandToggleHasContent = Boolean(expandToggles[0])
      && Array.from(expandToggles[0].querySelectorAll("*")).some(visible)
    expandToggles[0]?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const providers = (await call("llm.providers", {})).providers
    const models = (await call("llm.models", {})).groups
    const session = await call("session.create", { cwd: ${workspace} })
    const skills = (await call("skill.list", { sessionId: session.sessionId })).skills
    const freeProvider = providers.find((provider) => provider.provider === "opencode")
    const freeModels = models.find((group) => group.id === "opencode")?.models || []
    return JSON.stringify({
      sidebarBrandVisible,
      heroMarkVisible,
      heroHeadlineOverridden,
      heroPreviewBadgeHidden,
      heroMarkHeadlineOffset,
      automationSettingsEntryVisible,
      automationSidebarEntryAbsent,
      automationSurfaceVisible,
      automationCreateViaChatWorked,
      automationEditorVisible,
      automationEditorUsesFullWidth,
      automationAdvancedVisible,
      automationBackNavigationWorks,
      automationEditorHeaderFits,
      automationSaveWorks,
      automationDeleteDialogWorks,
      automationDirtyPauseBlocked,
      automationMetadataPlain,
      titlebarStripHeight,
      titlebarStripDraggable,
      contentInsetHeight,
      sidebarBrandTop,
      sidebarToggleCount: collapseToggles.length,
      sidebarCollapsed,
      sidebarExpandToggleCount: expandToggles.length,
      sidebarExpandToggleUsable,
      sidebarExpandToggleHasContent,
      sidebarExpandedAgain: !document.querySelector("[data-sidebar-collapsed]"),
      platform: typeof navigator === "undefined" ? "" : navigator.platform,
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

export async function inspectCiSmokePersistence(target: CdpTarget, sessionId: string, dshHome: string) {
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
    return JSON.stringify(sessions.map((session) => session.sessionId))
  })()`
  const restored = await evaluateCiSmokeJson(target, expression) as string[]
  if (restored.includes(sessionId)) return

  // 这条断言只在重启后失败一次就没有第二次机会：进程已经换了一个，现场只剩磁盘。
  // 所以失败信息要自带现场 —— 重启后实际读回哪些会话，以及 DSH home 里到底躺着
  // 什么文件。区分「根本没写」和「写了但没读回来」全靠这两样。
  throw new Error([
    `DSH session ${sessionId} did not survive desktop restart`,
    `sessions after restart: ${restored.length ? restored.join(", ") : "(none)"}`,
    `DSH home contents:\n${describeDirectory(dshHome)}`,
  ].join("\n"))
}

function describeDirectory(dir: string, prefix = "  "): string {
  if (!existsSync(dir)) return `${prefix}(missing) ${dir}`
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return [`${prefix}${entry.name}/`, describeDirectory(full, `${prefix}  `)]
      const info = statSync(full)
      return [`${prefix}${entry.name} ${info.size}B mtime=${info.mtimeMs}`]
    })
    .join("\n")
}

export function assertCiSmokeProduct(snapshot: CiSmokeProductSnapshot) {
  // 原生窗口控件画在内容坐标系里，顶带是唯一声明这块安全区的地方。四条一起看：
  // 无边框的平台必须有带子、带子高度等于主进程给的数字、带子可拖、内容按同一个
  // 数字下移 —— 少任何一条，侧边栏左上角就会重新压到交通灯或 Windows overlay
  // 按钮下面。第一条的期望来自 window-options 的无边框决定，和高度不是同一个
  // 来源；否则整个特性被平台关掉时，期望值会跟着归零，断言静默通过。
  const frameless = "titleBarStyle" in dshTitleBarOptions(process.platform)
  const expectedTitlebarHeight = titlebarHeight(process.platform)
  const failures = [
    snapshot.sidebarBrandVisible ? null : "PawWork sidebar brand is not rendered",
    frameless === expectedTitlebarHeight > 0
      ? null
      : `frameless=${frameless} but the reserved titlebar strip is ${expectedTitlebarHeight}px`,
    snapshot.titlebarStripHeight === expectedTitlebarHeight
      ? null
      : `titlebar strip is ${snapshot.titlebarStripHeight}px, expected ${expectedTitlebarHeight}px`,
    snapshot.titlebarStripDraggable ? null : "titlebar strip is not a drag region",
    snapshot.contentInsetHeight === expectedTitlebarHeight
      ? null
      : `web content is inset ${snapshot.contentInsetHeight}px, expected ${expectedTitlebarHeight}px`,
    snapshot.sidebarBrandTop >= expectedTitlebarHeight
      ? null
      : `sidebar brand starts at ${snapshot.sidebarBrandTop}px, inside the native window controls`,
    snapshot.heroMarkVisible ? null : "PawWork hero brand mark is not rendered",
    snapshot.heroHeadlineOverridden ? null : "hero headline fell back to DSH copy",
    snapshot.heroPreviewBadgeHidden ? null : "DSH preview badge is still visible on the hero",
    snapshot.heroMarkHeadlineOffset <= 1 ? null : `hero mark sits ${snapshot.heroMarkHeadlineOffset.toFixed(1)}px off the headline centre`,
    snapshot.automationSettingsEntryVisible ? null : "Automation Settings entry is not visible",
    snapshot.automationSidebarEntryAbsent ? null : "Automation should not occupy the sidebar",
    snapshot.automationSurfaceVisible ? null : "Automation surface did not open",
    snapshot.automationCreateViaChatWorked ? null : "Automation did not create through the visible chat path",
    snapshot.automationEditorVisible ? null : "Automation editor did not open",
    snapshot.automationEditorUsesFullWidth ? null : "Automation editor is compressed instead of using the Settings column",
    snapshot.automationAdvancedVisible ? null : "Automation advanced settings did not expand",
    snapshot.automationBackNavigationWorks ? null : "Automation Back navigation did not restore the list",
    snapshot.automationEditorHeaderFits ? null : "Automation editor header overflows the Settings column",
    snapshot.automationSaveWorks ? null : "Automation editor did not save through the visible form",
    snapshot.automationDeleteDialogWorks ? null : "Automation delete confirmation is not a cancellable dialog",
    snapshot.automationDirtyPauseBlocked ? null : "Automation pause can discard unsaved edits",
    snapshot.automationMetadataPlain ? null : "Automation immutable metadata is not plain read-only text",
    snapshot.sidebarToggleCount === 1 ? null : `expected one DSH collapse control, found ${snapshot.sidebarToggleCount}`,
    snapshot.sidebarCollapsed ? null : "DSH collapse control did not collapse the sidebar",
    snapshot.sidebarExpandToggleCount === 1 ? null : `expected one DSH expand control, found ${snapshot.sidebarExpandToggleCount}`,
    snapshot.sidebarExpandToggleUsable ? null : "DSH expand control is not visibly clickable",
    snapshot.sidebarExpandToggleHasContent ? null : "collapsed sidebar expand control renders empty",
    snapshot.sidebarExpandedAgain ? null : "DSH expand control did not reopen the sidebar",
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

// Windows has no signals: child.kill maps to TerminateProcess on this one PID,
// so the app gets no shutdown path and any sidecar it spawned is orphaned. Log
// how the app actually went down — a restart that loses state reads very
// differently depending on whether the first process was asked or shot.
async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill("SIGTERM")
  const result = await Promise.race([once(child, "exit").then(() => "exit"), delay(5_000).then(() => "timeout")])

  if (result === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await once(child, "exit").catch(() => undefined)
  }
  console.log(`CI smoke stopped desktop app: code=${child.exitCode} signal=${child.signalCode}`)
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
      title: "AutomationTitleWithoutBreaksAutomationTitleWithoutBreaksAutomationTitleWithoutBreaksAutomationTitleWithoutBreaks",
      prompt: "Verify the Automation editor.",
      revision: 1,
      paused: true,
      context: "fresh",
      cwd: join(homeDir, "WorkspaceWithoutBreaksWorkspaceWithoutBreaksWorkspaceWithoutBreaksWorkspaceWithoutBreaks"),
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
      await inspectCiSmokePersistence(restartTarget, product.sessionId, dshHome)
      console.log("CI smoke verified DSH session persistence after restart")
    } finally {
      restartLogs.close()
      await stopChild(restarted.child)
    }
  }
}

// tsx wraps the entry module, and there `import.meta.main` is undefined — the
// smoke would exit 0 having verified nothing. Every caller (package script and
// both packaged CI jobs) runs through tsx, so compare the entry path instead.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
