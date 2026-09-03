import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process"
import { once } from "node:events"
import type { Readable } from "node:stream"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import readline from "node:readline"
import { PAWWORK_APP, type PawWorkChannel, isPawWorkChannel } from "../src/main/app-identity.ts"
import { parseCdpPort } from "../src/main/ci-smoke-cdp.ts"
import { resolveDshHome } from "../src/main/pawwork-home.ts"
import { dshTitleBarOptions } from "../src/main/window-options.ts"
import { packagedAppEnv } from "./packaged-app-env.ts"
import {
  CI_SMOKE_IMPORTED_AUTOMATION_ID,
  CI_SMOKE_IMPORTED_SESSION_ID,
  createCiSmokeV1Fixture,
} from "./ci-smoke-v1-fixture.ts"
const require = createRequire(import.meta.url)
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export type SmokeMode = "raw" | "packaged"

export type SmokeTarget =
  | { mode: "raw"; channel: PawWorkChannel }
  | { mode: "packaged"; channel: PawWorkChannel; executablePath: string }

// stdio is ["ignore", "pipe", "pipe"], so stdin really is null at runtime.
type SmokeChild = ChildProcessByStdio<null, Readable, Readable>

type LaunchedApp = {
  child: SmokeChild
  spawnError: { current: Error | undefined }
}

type CdpTarget = {
  type?: unknown
  url?: unknown
  webSocketDebuggerUrl?: unknown
}

export type CiSmokeProductSnapshot = {
  sidebarExpandedBrandHidden: boolean
  sidebarCollapsedBrandHidden: boolean
  heroMarkVisible: boolean
  heroHeadlineOverridden: boolean
  heroPreviewBadgeHidden: boolean
  heroMarkHeadlineOffset: number
  automationSettingsEntryVisible: boolean
  updateSettingsEntryVisible: boolean
  webSearchCardVisible: boolean
  updateSectionVisible: boolean
  updateSectionReportsStatus: boolean
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
  automationDatePopoutWorks: boolean
  automationDateEscapeCloses: boolean
  cursorMismatches: string[]
  cursorProbeCaught: string[]
  titlebarStripHeight: number
  titlebarStripDraggable: boolean
  contentInsetHeight: number
  titlebarInsetLeft: number
  titlebarInsetRight: number
  windowsInsetMatchesDocumentDirection: boolean
  windowsBrowseDirectoryPickerWorked: boolean
  expandedNewSessionFollowsTitlebar: boolean
  sidebarPrimaryActionCenterOffsets: { addWorkspace: number | null; newSession: number | null }
  collapsedSidebarFullyMergesWithContent: boolean
  sessionHeaderComposerLeftAlignmentOffset: { expanded: number | null; collapsed: number | null }
  sessionHeaderRightBoundaryIntrusion: { expanded: number | null; collapsed: number | null }
  sessionHeaderDividerHidden: boolean
  collapsedSessionContentAlignmentOffset: number | null
  collapsedSessionTitleGap: number | null
  sidebarCollapseMotionMatchesPreference: boolean
  expandedNativeControlOverlaps: string[]
  collapsedNativeControlOverlaps: string[]
  sidebarToggleCount: number
  sidebarCollapsed: boolean
  sidebarExpandToggleCount: number
  sidebarExpandToggleUsable: boolean
  sidebarExpandToggleHasContent: boolean
  sidebarExpandedAgain: boolean
  platform: string
  freeProviderActive: boolean
  v1SessionImported: boolean
  v1SessionVisibleInSidebar: boolean
  skillNames: string[]
  sessionId: string
  sessionIdsBeforeRestart: string[]
}

export type CiSmokeFreeModelTurn = {
  provider: string
  model: string
  requested: boolean
  answered: boolean
  code: string | null
  events: string[]
}

type ProbeOptions = {
  attempts?: number
  delayMs?: number
  // The probe only ever calls this with a plain URL string.
  fetch?: (url: string) => Promise<Response>
  sleep?: (ms: number) => Promise<unknown>
}

type BuildSmokeEnvOptions = {
  cdpPort?: number
  v1Database?: string
}

type LaunchAppOptions = {
  cdpPort?: number
  v1Database?: string
}

type ScreenshotRunner = (command: string, args: string[]) => {
  error?: Error
  status: number | null
  stderr?: Buffer | string | null
}

export function captureWindowsAppScreenshot(
  platform: NodeJS.Platform,
  processId: number,
  outputPath: string | undefined,
  run: ScreenshotRunner = (command, args) => spawnSync(command, args, { encoding: "utf8" }),
) {
  if (platform !== "win32" || outputPath === undefined) return
  const script = resolve(import.meta.dirname, "capture-windows-window.ps1")
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-TargetProcessId",
    String(processId),
    "-OutputPath",
    outputPath,
  ]
  const result = run("powershell.exe", args)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Windows screenshot failed with exit code ${result.status}: ${String(result.stderr ?? "").trim()}`)
  }
  console.log(`CI smoke captured Windows window: ${outputPath}`)
}

function parseChannel(raw: string | undefined): PawWorkChannel {
  if (raw === undefined || raw === "") return "dev"
  if (!isPawWorkChannel(raw)) throw new Error(`Unsupported smoke channel: ${raw}`)
  return raw
}

// A raw run is an unpackaged app, and index.ts pins those to dev the same way.
function channelForSmoke(channel: PawWorkChannel, mode: SmokeMode): PawWorkChannel {
  return mode === "raw" ? "dev" : channel
}

export function appIdForSmoke(channel: PawWorkChannel, mode: SmokeMode) {
  return PAWWORK_APP[channelForSmoke(channel, mode)].id
}

// PAWWORK_CI_SMOKE_HOME, not HOME: buildSmokeEnv cannot redirect os.homedir()
// on Windows, where it reads USERPROFILE.
export function dshHomeForSmoke(homeDir: string, target: SmokeTarget) {
  return resolveDshHome({ channel: channelForSmoke(target.channel, target.mode), homeRoot: homeDir })
}

// Seeded into the legacy home and asserted in the new one, so it is only ever
// present because the one-time migration ran.
export const CI_SMOKE_MIGRATED_AUTOMATION_ID = "automation-smoke"
export const CI_SMOKE_ONESHOT_AUTOMATION_ID = "automation-smoke-oneshot"

export function parseSmokeArgs(argv: string[]): SmokeTarget {
  const mode = argv[0] as SmokeMode | undefined
  if (mode === undefined || mode === "raw") {
    return { mode: "raw", channel: parseChannel(argv[1]) }
  }
  if (mode !== "packaged") throw new Error(`Unsupported smoke mode: ${mode}`)

  // Where electron-builder put the app is not the caller's business: the two
  // smoke workflows used to spell the path out by hand, once per platform.
  const channel = parseChannel(argv[1])
  const executablePath = argv[2] ? resolve(argv[2]) : packagedAppEnv(channel).EXECUTABLE_PATH
  if (!existsSync(executablePath)) throw new Error(`Packaged smoke executable not found: ${executablePath}`)
  return { mode, channel, executablePath }
}

export function resolveMainEntry() {
  return resolve(import.meta.dirname, "../out/main/index.js")
}

/**
 * This script runs the built main bundle, and nothing in it builds. A run
 * against a stale `out/` exercises whatever was last compiled while reporting
 * on the source in front of you — it passes, and the pass means nothing. CI
 * builds in the step before, so this only ever fires locally, which is where
 * the mistake is silent.
 * @returns the newest source file left out of the build, or null when there is
 * no build at all; undefined when the build is current.
 */
export function staleMainEntry(mainEntry = resolveMainEntry(), sourceRoot = resolve(import.meta.dirname, "../src")) {
  let built: number
  try {
    built = statSync(mainEntry).mtimeMs
  } catch {
    // Nothing built at all. Reporting the entry as its own offender reads as
    // "index.js is newer than index.js"; the caller says the useful thing.
    return null
  }
  const newer = (readdirSync(sourceRoot, { recursive: true }) as string[])
    // Test files and their helpers are not in the bundle, so editing one is not
    // a reason to rebuild — and a guard that cries wolf gets bypassed.
    .filter((file) => /\.(?:ts|tsx|cjs|mjs|js)$/.test(file) && !/\.(?:test|testing)\.tsx?$/.test(file))
    .find((file) => statSync(join(sourceRoot, file)).mtimeMs > built)
  return newer === undefined ? undefined : join(sourceRoot, newer)
}

export function buildSmokeEnv(
  homeDir: string,
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
    ...(options.cdpPort !== undefined ? { PAWWORK_CI_SMOKE_CDP_PORT: String(options.cdpPort) } : {}),
    ...(options.v1Database !== undefined ? { PAWWORK_V1_DATABASE: options.v1Database } : {}),
  }
}

export function parseSmokeCdpPort(raw: string | undefined) {
  if (raw === undefined || raw === "") return undefined
  const port = parseCdpPort(raw)
  if (port === undefined) throw new Error(`Invalid CI smoke CDP port: ${raw}`)
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

export async function inspectCiSmokeProduct(target: CdpTarget, workspacePath: string, expectedV1SessionId = CI_SMOKE_IMPORTED_SESSION_ID) {
  const workspace = JSON.stringify(workspacePath)
  const expectedSession = JSON.stringify(expectedV1SessionId)
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
    const waitFor = async (read, attempts = 400, delayMs = 25) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const value = await read()
        if (value) return value
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return null
    }
    // The arrow rule's own selector, read back from the live stylesheet rather than copied here, so the
    // probe cannot drift from the rule it checks. A missing rule reports itself instead of passing.
    const arrowSelector = () => Array.from(document.styleSheets)
      .flatMap((sheet) => { try { return Array.from(sheet.cssRules) } catch { return [] } })
      .find((rule) => rule.style?.cursor === "default" && rule.selectorText?.includes("[aria-haspopup]"))?.selectorText
    // Two directions, both scanned document-wide: a link that lost the hand fails as loudly as a
    // control the rule claims and did not win. Elements outside the rule's reach — DSH's clickable
    // bare divs, which carry no role to match on — are out of contract and deliberately not asserted.
    const cursorMismatches = () => {
      const selector = arrowSelector()
      if (!selector) return ["<arrow cursor rule missing from the document>"]
      return Array.from(new Set(Array.from(document.querySelectorAll("*"))
        .filter((element) => {
          const pointer = getComputedStyle(element).cursor === "pointer"
          return element.matches("a[href]") ? !pointer : pointer && element.matches(selector)
        })
        // classList rather than splitting className: a regex literal loses its backslash on the way
        // into Runtime.evaluate, so /\s+/ arrived as /s+/ and cut class names at every letter s.
        .map((element) => element.tagName.toLowerCase() + (element.classList[0] ? "." + element.classList[0] : ""))))
    }
    // A probe that quietly stops reporting is worse than no probe, and this one is easy to break: it
    // depends on a selector read back at runtime. So plant one failure in each direction, confirm both
    // come back, and take them away again.
    const cursorProbeDetects = () => {
      const plant = (tag, cursor) => {
        const element = document.createElement(tag)
        element.className = "pawwork-cursor-probe"
        if (tag === "a") element.href = "https://example.com"
        element.style.setProperty("cursor", cursor, "important")
        document.body.appendChild(element)
        return element
      }
      const planted = [plant("a", "default"), plant("button", "pointer")]
      const caught = cursorMismatches().filter((id) => id.endsWith(".pawwork-cursor-probe"))
      planted.forEach((element) => element.remove())
      return caught
    }
    const call = async (method, args) => {
      const request = { type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args } }
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
    const sidebarPrimaryActions = () => {
      const find = (pattern) => Array.from(document.querySelectorAll("button")).find((button) => {
        const label = button.getAttribute("aria-label") || ""
        return visible(button) && pattern.test(label)
      })
      return {
        addWorkspace: find(/^(添加工作区|Add workspace)$/i),
        newSession: find(/^(新建会话|New session)$/i),
      }
    }
    const waitForSidebarPrimaryActions = async () => {
      let actions = sidebarPrimaryActions()
      for (let frame = 0; frame < 60 && !(actions.addWorkspace && actions.newSession); frame += 1) {
        await new Promise((resolve) => setTimeout(resolve, 16))
        actions = sidebarPrimaryActions()
      }
      return actions
    }
    const isWindows = /^Win/i.test(navigator.platform)
    let selectedWorkspace = ${workspace}
    if (!isWindows) await call("workspace/create", { request: { path: ${workspace} } })
    let expandedPrimaryActions = await waitForSidebarPrimaryActions()
    let windowsBrowseDirectoryPickerWorked = !isWindows
    if (isWindows) {
      if (!expandedPrimaryActions.addWorkspace) throw new Error("Windows smoke could not find Add workspace")
      const expectedPickedDirectory = (await call("directoryPicker/list", {})).path
      expandedPrimaryActions.addWorkspace.click()

      const browseDialog = await waitFor(() => Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => {
        const title = dialog.querySelector("h2")?.textContent?.trim() || ""
        return visible(dialog) && /^(选择工作区目录|Select Workspace Directory)$/i.test(title)
      }))
      if (!browseDialog) throw new Error("Windows browse directory picker did not open")

      const openDirectory = await waitFor(() => Array.from(browseDialog.querySelectorAll("button")).find((button) => {
        const label = (button.getAttribute("aria-label") || button.textContent || "").trim()
        return visible(button) && !button.disabled && /^(打开|Open)$/i.test(label)
      }))
      if (!openDirectory) throw new Error("Windows browse directory picker never enabled Open")

      // DSH 0.1.2-alpha.2 dropped the \`workspace.list\` RPC — the client reads the
      // set through the \`workspace/follow\` stream, which this raw-fetch helper
      // cannot open, and every read-only replacement is a stream too. So this
      // asserts in two halves, neither of which passes alone.
      //
      // First, wait for the sidebar the picker writes into to carry a leaf with
      // that name which was not there before Open. That wait is a
      // synchronisation point, not evidence: the scan is document-wide, and a
      // re-render replacing rather than reusing a node satisfies it. It is here
      // so the call below runs after the picker has finished, not instead of it.
      //
      // The assertion itself is identity, through \`workspace/create\`'s idempotence: it answers
      // \`created: false\` for a path already registered. One call after adoption
      // therefore proves the workspace the picker made is over the directory the
      // picker reported — and \`created: true\` means the DOM leaf came from
      // somewhere else. Calling it before the click, or in a retry loop, would
      // register the path itself and make the answer meaningless.
      const expectedWorkspaceName = expectedPickedDirectory.split(/[\\\\/]/).filter(Boolean).pop()
      const namedWorkspaceLeaves = () => Array.from(document.querySelectorAll("*"))
        .filter((element) => element.childElementCount === 0
          && visible(element)
          && (element.textContent || "").trim() === expectedWorkspaceName)
      const leavesBeforePick = new Set(namedWorkspaceLeaves())
      openDirectory.click()

      const adoptedWorkspaceLeaf = await waitFor(() => namedWorkspaceLeaves().find((element) => !leavesBeforePick.has(element)))
      if (!adoptedWorkspaceLeaf) throw new Error("Windows browse directory picker did not create the selected workspace")

      const browseDialogClosed = await waitFor(() => !visible(browseDialog))
      if (!browseDialogClosed) throw new Error("Windows browse directory picker stayed open after selection")

      const readopted = await call("workspace/create", { request: { path: expectedPickedDirectory } })
      if (readopted.created) throw new Error("Windows browse directory picker did not register the directory it reported")

      selectedWorkspace = expectedPickedDirectory
      windowsBrowseDirectoryPickerWorked = true
      expandedPrimaryActions = await waitForSidebarPrimaryActions()
    }
    const sidebarToggles = () => Array.from(document.querySelectorAll("button.pawwork-sidebar-toggle")).filter(visible)
    const sidebarBrandButton = document.querySelector('[data-slot="sidebar.brand.name"]')?.closest("button")
    const sidebarExpandedBrandHidden = Boolean(sidebarBrandButton) && !visible(sidebarBrandButton)
    const titlebarStrip = document.querySelector(".pawwork-window-drag-region")
    const titlebarStripHeight = titlebarStrip ? titlebarStrip.getBoundingClientRect().height : -1
    const titlebarStripDraggable = Boolean(titlebarStrip)
      && getComputedStyle(titlebarStrip).getPropertyValue("-webkit-app-region").trim() === "drag"
    const insetProbe = document.createElement("div")
    insetProbe.style.cssText = 'box-sizing:border-box;height:0;padding-left:var(--pawwork-titlebar-inset-left,0px);padding-right:var(--pawwork-titlebar-inset-right,0px);position:fixed;visibility:hidden;width:100vw'
    document.body.appendChild(insetProbe)
    const insetStyle = getComputedStyle(insetProbe)
    const titlebarInsetLeft = Number.parseFloat(insetStyle.paddingLeft)
    const titlebarInsetRight = Number.parseFloat(insetStyle.paddingRight)
    insetProbe.remove()
    const documentDirection = getComputedStyle(document.documentElement).direction
    const windowsInsetMatchesDocumentDirection = !/^Win/i.test(navigator.platform)
      || (documentDirection === "rtl"
        ? titlebarInsetLeft > 0 && titlebarInsetRight === 0
        : titlebarInsetLeft === 0 && titlebarInsetRight > 0)
    const expandedNewSession = expandedPrimaryActions.newSession
    const expandedNewSessionGap = expandedNewSession
      ? expandedNewSession.getBoundingClientRect().top - titlebarStripHeight
      : -1
    const expandedNewSessionFollowsTitlebar = !/^Mac/i.test(navigator.platform)
      || titlebarInsetLeft === 0
      || (expandedNewSessionGap >= 8 && expandedNewSessionGap <= 16)
    const expandedAddWorkspace = expandedPrimaryActions.addWorkspace
    const centerY = (element) => {
      const rect = element?.getBoundingClientRect()
      return rect ? rect.top + rect.height / 2 : Number.NaN
    }
    const expandedNewSessionCenter = centerY(expandedNewSession)
    const expandedAddWorkspaceCenter = centerY(expandedAddWorkspace)
    const nativeControlOverlaps = () => {
      const rightStart = innerWidth - titlebarInsetRight
      return Array.from(document.querySelectorAll('button, a, input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"]'))
        .filter(visible)
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          const overlapsLeft = titlebarInsetLeft > 0 && rect.left < titlebarInsetLeft && rect.right > 0 && rect.top < titlebarStripHeight && rect.bottom > 0
          const overlapsRight = titlebarInsetRight > 0 && rect.left < innerWidth && rect.right > rightStart && rect.top < titlebarStripHeight && rect.bottom > 0
          return overlapsLeft || overlapsRight
        })
        .map((element) => {
          const label = (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 40)
          return element.tagName.toLowerCase() + (label ? '[' + label + ']' : '')
        })
    }
    const expandedNativeControlOverlaps = nativeControlOverlaps()
    const cursorProbeCaught = cursorProbeDetects()
    const heroCursorMismatches = cursorMismatches()
    const appRoot = document.getElementById("root")
    const contentInsetHeight = appRoot ? Number.parseFloat(getComputedStyle(appRoot).paddingTop) : -1
    // Assert that the headline override still fires, not the copy it produces: the mechanism is
    // what broke silently between rc.7 and rc.8.
    const heroMark = document.querySelector('[data-slot="conversation.hero.brand.mark"] > svg')
    const heroHeadline = heroMark?.parentElement?.parentElement?.nextElementSibling
    const heroBadge = heroHeadline?.nextElementSibling
    const heroMarkVisible = visible(heroMark)
    const heroHeadlineOverridden = Boolean(heroHeadline)
      && getComputedStyle(heroHeadline).fontSize === "0px"
      && getComputedStyle(heroHeadline, "::before").content.replace(/^"|"$/g, "").trim().length > 0
    const heroPreviewBadgeHidden = Boolean(heroHeadline) && !visible(heroBadge)
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
    const updateSettingsEntry = visibleButton(/^(软件更新|Software Update)$/i)
    const updateSettingsEntryVisible = visible(updateSettingsEntry)
    updateSettingsEntry?.click()
    for (let attempt = 0; attempt < 20 && !visible(document.querySelector(".pawwork-update-section")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const updateSectionVisible = visible(document.querySelector(".pawwork-update-section"))
    // The smoke runs an unpackaged or non-prod build, so the updater is gated off and the
    // section must say so; a packaged prod smoke may instead be mid-check. Either way the
    // status card must carry live text from the bridge, not an empty shell.
    const updateStatusText = (document.querySelector(".pawwork-update-status")?.textContent || "").trim()
    const updateSectionReportsStatus = updateStatusText.length > 0
    // A Host settings namespace renders nothing on its own: the card that draws
    // it is a client plugin, and the two halves fail independently. The Host
    // half surviving alone leaves a namespace no user can reach — which reads,
    // from every wire probe, exactly like a working feature. The card renders
    // only once its bound scope reports \`ready\`, so its presence is evidence
    // for both halves at once.
    const pluginsSettingsEntry = visibleButton(/^(插件|Plugins)$/i)
    pluginsSettingsEntry?.click()
    for (let attempt = 0; attempt < 20 && !visible(document.querySelector(".pawwork-websearch-card")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const webSearchCardVisible = visible(document.querySelector(".pawwork-websearch-card"))
    // The automation flow below expects its own surface; navigate back first.
    visibleButton(/^(自动化|Automations)$/i)?.click()
    for (let attempt = 0; attempt < 20 && !visible(document.querySelector(".pawwork-automations-surface")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    document.querySelector(".pawwork-automations-create")?.click()
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
    // Workspace and Session are shown, never edited: each carries its value as text, with no
    // control inside it that would invite an edit the editor cannot make.
    const automationMetadataPlain = readonlyMetadata.length === 2
      && readonlyMetadata.every((node) => (node.textContent || "").trim() !== ""
        && node.querySelector("input, select, textarea, button") === null)
    const titleInput = document.querySelector('input.pawwork-automation-input')
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
    // A one-shot schedule is edited through the editor's own calendar, the one control DSH does not
    // supply. It has to open over the form and inside the window, not push the fields below it down.
    const oneshotRow = Array.from(document.querySelectorAll(".pawwork-automation-row"))
      .find((row) => (row.textContent || "").includes("Smoke one-shot automation"))
    oneshotRow?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const dateTrigger = document.querySelector("button.pawwork-automation-select")
    const formBeforeCalendar = document.querySelector(".pawwork-automation-form")?.getBoundingClientRect().height
    dateTrigger?.click()
    for (let attempt = 0; attempt < 20 && !visible(document.querySelector(".pawwork-automation-calendar")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const calendar = document.querySelector(".pawwork-automation-calendar")
    const calendarRect = calendar?.getBoundingClientRect()
    const automationDatePopoutWorks = Boolean(
      visible(calendar) && calendarRect
      && calendarRect.top >= 0 && calendarRect.left >= 0
      && calendarRect.bottom <= window.innerHeight && calendarRect.right <= window.innerWidth
      && document.querySelector(".pawwork-automation-form")?.getBoundingClientRect().height === formBeforeCalendar,
    )
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const automationDateEscapeCloses = automationDatePopoutWorks
      && !visible(document.querySelector(".pawwork-automation-calendar"))
      && visible(document.querySelector(".pawwork-automation-panel"))
    visibleButton(/^(返回自动化|Back to Automations)$/i)?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const settingsClose = Array.from(document.querySelectorAll("button")).find((button) => {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim()
      return visible(button) && /^(关闭|Close)$/i.test(label) && !button.closest(".pawwork-automation-panel")
    })
    settingsClose?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Sample again here: the hero page carries no [data-expandable] rows, so measuring only the
    // first screen would miss the conversation surface entirely.
    const settledCursorMismatches = cursorMismatches()
    // The title and view tabs do not exist on the blank hero. Open the imported
    // non-empty session before collapsing so this probe exercises the same
    // session chrome a user sees while an agent is running.
    const sidebarSessionLeaf = () => Array.from(document.querySelectorAll("*"))
      .find((element) => element.childElementCount === 0
        && visible(element)
        && (element.textContent || "").trim() === "Imported V1 session")
    let v1SessionImported = false
    let v1SessionVisibleInSidebar = false
    const importDeadline = Date.now() + 120_000
    while (!v1SessionVisibleInSidebar && Date.now() < importDeadline) {
      const sessionLeaf = sidebarSessionLeaf()
      const sessions = (await call("session/list", { _request: {} })).items
      v1SessionImported = sessions.some((item) => item.sessionId === ${expectedSession})
      if (sessionLeaf) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        v1SessionVisibleInSidebar = Boolean(sidebarSessionLeaf())
      }
      if (!v1SessionVisibleInSidebar) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    sidebarSessionLeaf()?.closest('[role="treeitem"]')?.click()
    const currentSessionHeader = () => document.querySelector('[data-slot="conversation.session.header"] > header')
    const currentSessionTabs = () => currentSessionHeader()?.querySelector('[role="tablist"]')
    const currentComposerCard = () => document.querySelector('[data-composer-card]')
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      if (visible(currentSessionHeader()) && visible(currentSessionTabs())) break
    }
    const sessionHeaderDividerHidden = () => {
      const header = currentSessionHeader()
      return header ? getComputedStyle(header, "::after").display === "none" : false
    }
    const sessionHeaderComposerLeftAlignmentOffset = (safeLeft = Number.NEGATIVE_INFINITY) => {
      const titleRow = currentSessionHeader()?.firstElementChild
      const titleRect = titleRow?.getBoundingClientRect()
      const composerRect = currentComposerCard()?.getBoundingClientRect()
      if (!titleRect || !composerRect) return null
      return Math.abs(titleRect.left - Math.max(composerRect.left, safeLeft))
    }
    const sessionHeaderRightBoundaryIntrusion = () => {
      const titleRect = currentSessionHeader()?.firstElementChild?.getBoundingClientRect()
      const composerRect = currentComposerCard()?.getBoundingClientRect()
      if (!titleRect || !composerRect) return null
      const nativeSafeRight = innerWidth - titlebarInsetRight - 28
      return Math.max(0, titleRect.right - composerRect.right, titleRect.right - nativeSafeRight)
    }
    const expandedSessionHeaderComposerLeftAlignmentOffset = sessionHeaderComposerLeftAlignmentOffset()
    const expandedSessionHeaderRightBoundaryIntrusion = sessionHeaderRightBoundaryIntrusion()

    const collapseToggles = sidebarToggles()
    collapseToggles[0]?.click()
    // The DSH rail remounts, while PawWork's shell.overlay toggle stays stable. Wait for both the
    // collapsed state and the one visible PawWork control before measuring the new state.
    let expandToggles = []
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      expandToggles = sidebarToggles()
      if (document.querySelector("[data-sidebar-collapsed]") && expandToggles.length > 0) break
    }
    const sidebarCollapsed = Boolean(document.querySelector("[data-sidebar-collapsed]"))
    const collapsedBrandButton = document.querySelector('[data-sidebar-collapsed] [data-slot="sidebar.brand.mark"]')?.closest("button")
    const sidebarCollapsedBrandHidden = Boolean(collapsedBrandButton) && !visible(collapsedBrandButton)
    const sidebarExpandToggleUsable = usable(expandToggles[0])
    // The PawWork-owned toggle retains its icon across both sidebar states.
    const sidebarExpandToggleHasContent = Boolean(expandToggles[0])
      && Array.from(expandToggles[0].querySelectorAll("*")).some(visible)
    const collapsedFrame = document.querySelector("[data-sidebar-collapsed]")
    const collapsedSidebarSlot = document.querySelector('[data-slot="sidebar"]')
    const collapsedSidebarSurfaces = [collapsedSidebarSlot?.parentElement, collapsedSidebarSlot?.firstElementChild]
      .filter(Boolean)
    const collapsedSurfaceState = () => {
      const contentSurface = collapsedFrame ? getComputedStyle(collapsedFrame).backgroundColor : ""
      const surfacesMatch = contentSurface !== ""
        && collapsedSidebarSurfaces.length === 2
        && collapsedSidebarSurfaces.every((surface) => getComputedStyle(surface).backgroundColor === contentSurface)
      const dividerHidden = collapsedSidebarSlot?.parentElement
        ? getComputedStyle(collapsedSidebarSlot.parentElement).borderRightColor === "rgba(0, 0, 0, 0)"
        : false
      return { dividerHidden, surfacesMatch }
    }
    let collapsedSurfaceStateValue = collapsedSurfaceState()
    for (let frame = 0; frame < 90 && !(collapsedSurfaceStateValue.surfacesMatch && collapsedSurfaceStateValue.dividerHidden); frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      collapsedSurfaceStateValue = collapsedSurfaceState()
    }
    const collapsedSidebarSurfaceMatchesContent = collapsedSurfaceStateValue.surfacesMatch
    const collapsedSidebarDividerHidden = collapsedSurfaceStateValue.dividerHidden
    const collapsedSidebarFullyMergesWithContent = collapsedSidebarSurfaceMatchesContent && collapsedSidebarDividerHidden
    const rectGap = (rightElement, leftElement) => {
      const right = rightElement?.getBoundingClientRect()
      const left = leftElement?.getBoundingClientRect()
      return right && left ? left.left - right.right : null
    }
    const collapsedSessionTitle = currentSessionHeader()?.querySelector("nav button:disabled")
    const collapsedSessionTab = currentSessionTabs()?.querySelector('[role="tab"]')
    const textStart = (element) => {
      const rect = element?.getBoundingClientRect()
      return rect ? rect.left + Number.parseFloat(getComputedStyle(element).paddingLeft) : null
    }
    const titleTextStart = textStart(collapsedSessionTitle)
    const tabTextStart = textStart(collapsedSessionTab)
    const collapsedSessionContentAlignmentOffset = titleTextStart !== null && tabTextStart !== null
      ? Math.abs(titleTextStart - tabTextStart)
      : null
    const collapsedToggleRect = expandToggles[0]?.getBoundingClientRect()
    const collapsedSessionHeaderComposerLeftAlignmentOffset = sessionHeaderComposerLeftAlignmentOffset(
      collapsedToggleRect ? collapsedToggleRect.right + 8 : Number.NaN,
    )
    const collapsedSessionHeaderRightBoundaryIntrusion = sessionHeaderRightBoundaryIntrusion()
    const collapsedSessionTitleGap = rectGap(expandToggles[0], collapsedSessionTitle)
    const collapsedPrimaryActions = await waitForSidebarPrimaryActions()
    const collapsedNewSession = collapsedPrimaryActions.newSession
    const collapsedAddWorkspace = collapsedPrimaryActions.addWorkspace
    const centerOffset = (collapsed, expandedCenter) => {
      const offset = centerY(collapsed) - expandedCenter
      return Number.isFinite(offset) ? offset : null
    }
    const sidebarPrimaryActionCenterOffsets = {
      addWorkspace: centerOffset(collapsedAddWorkspace, expandedAddWorkspaceCenter),
      newSession: centerOffset(collapsedNewSession, expandedNewSessionCenter),
    }
    const maxTransitionMs = (element) => Math.max(...getComputedStyle(element).transitionDuration.split(",").map((value) => {
      const duration = Number.parseFloat(value)
      return value.trim().endsWith("ms") ? duration : duration * 1000
    }))
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches
    const frameTransitionMs = collapsedFrame ? maxTransitionMs(collapsedFrame) : 0
    const surfaceTransitionMs = collapsedSidebarSurfaces.length === 2
      ? Math.min(...collapsedSidebarSurfaces.map(maxTransitionMs))
      : 0
    const sidebarCollapseMotionMatchesPreference = reducedMotion
      ? frameTransitionMs <= 1 && surfaceTransitionMs <= 1
      : frameTransitionMs >= 200 && frameTransitionMs <= 500
        && surfaceTransitionMs >= 200 && surfaceTransitionMs <= 500
    const collapsedNativeControlOverlaps = nativeControlOverlaps()
    expandToggles[0]?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))

    // \`llm/listProviders\` answers only the providers that actually registered an
    // adapter, so presence in this list is what \`active\` used to state, and \`name\`
    // carries the display name the product patch sets.
    const providers = await call("llm/listProviders", {})
    const session = await call("session/create", { request: { cwd: selectedWorkspace } })
    const skills = (await call("skills/list", { request: { sessionId: session.sessionId } })).skills
    const sessionIdsBeforeRestart = (await call("session/list", { _request: {} })).items.map((item) => item.sessionId)
    const freeProvider = providers.find((provider) => provider.id === "opencode")
    return JSON.stringify({
      sidebarExpandedBrandHidden,
      sidebarCollapsedBrandHidden,
      heroMarkVisible,
      heroHeadlineOverridden,
      heroPreviewBadgeHidden,
      heroMarkHeadlineOffset,
      automationSettingsEntryVisible,
      updateSettingsEntryVisible,
      webSearchCardVisible,
      updateSectionVisible,
      updateSectionReportsStatus,
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
      automationDatePopoutWorks,
      automationDateEscapeCloses,
      cursorMismatches: Array.from(new Set([...heroCursorMismatches, ...settledCursorMismatches])),
      cursorProbeCaught,
      titlebarStripHeight,
      titlebarStripDraggable,
      contentInsetHeight,
      titlebarInsetLeft,
      titlebarInsetRight,
      windowsInsetMatchesDocumentDirection,
      windowsBrowseDirectoryPickerWorked,
      expandedNewSessionFollowsTitlebar,
      sidebarPrimaryActionCenterOffsets,
      collapsedSidebarFullyMergesWithContent,
      sessionHeaderComposerLeftAlignmentOffset: {
        expanded: expandedSessionHeaderComposerLeftAlignmentOffset,
        collapsed: collapsedSessionHeaderComposerLeftAlignmentOffset,
      },
      sessionHeaderRightBoundaryIntrusion: {
        expanded: expandedSessionHeaderRightBoundaryIntrusion,
        collapsed: collapsedSessionHeaderRightBoundaryIntrusion,
      },
      sessionHeaderDividerHidden: sessionHeaderDividerHidden(),
      collapsedSessionContentAlignmentOffset,
      collapsedSessionTitleGap,
      sidebarCollapseMotionMatchesPreference,
      expandedNativeControlOverlaps,
      collapsedNativeControlOverlaps,
      sidebarToggleCount: collapseToggles.length,
      sidebarCollapsed,
      sidebarExpandToggleCount: expandToggles.length,
      sidebarExpandToggleUsable,
      sidebarExpandToggleHasContent,
      sidebarExpandedAgain: !document.querySelector("[data-sidebar-collapsed]"),
      platform: typeof navigator === "undefined" ? "" : navigator.platform,
      freeProviderActive: freeProvider !== undefined && freeProvider.name === "OpenCode Free",
      v1SessionImported,
      v1SessionVisibleInSidebar,
      skillNames: skills.map((skill) => skill.name).sort(),
      sessionId: session.sessionId,
      sessionIdsBeforeRestart,
    })
  })()`

  return await evaluateCiSmokeJson(target, expression, 180_000) as CiSmokeProductSnapshot
}

/**
 * Send one real turn on the model a fresh install starts with, and report what came back.
 *
 * A registered provider is not a usable one: the free routes authenticate with the
 * credential the product seeds, and a key the gateway rejects answers 401 — which nothing
 * in the product snapshot can see, because until this runs no request has left the app.
 *
 * Its own CDP evaluation rather than another probe folded into that snapshot: this one
 * waits on a live model, and sharing a budget with the UI probes would report every
 * unrelated UI failure as a timeout with nothing to read.
 */
export async function inspectCiSmokeFreeModelTurn(target: CdpTarget, sessionId: string) {
  const productSessionId = JSON.stringify(sessionId)
  const expression = `(async () => {
    const call = async (method, args) => {
      const request = { type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args } }
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
    const selection = (await call("session/modelCatalog", {})).default
    // The workspace the product probe already adopted, which is the only one this run is
    // known to hold: on Windows it comes from the native picker, not from the harness.
    const cwd = (await call("session/list", { _request: {} })).items
      .find((item) => item.sessionId === ${productSessionId})?.cwd
    const turn = await call("session/create", { request: cwd === undefined ? {} : { cwd } })
    await call("session/prompt", {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: turn.sessionId,
        mode: "queue",
        content: [{ type: "text", text: "Reply with the single word: pong" }],
      },
    })
    const deadline = Date.now() + 90000
    let records = []
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const item = (await call("session/list", { _request: {} })).items
        .find((entry) => entry.sessionId === turn.sessionId)
      // A page is read up to a cursor the caller already holds, and the only one on offer
      // here is the projection's. \`-1\` is a legal cursor meaning "through nothing", so
      // passing it reads an empty page forever instead of failing.
      const throughSeq = item?.projections?.asOfSeq
      if (throughSeq !== undefined && throughSeq >= 0) {
        records = (await call("session/page", {
          request: { address: { kind: "session", sessionId: turn.sessionId }, throughSeq, maxMessages: 200 },
        })).records
        if (item.running === false && records.some((record) => record.event?.type === "turn/end")) break
      }
      if (Date.now() > deadline) break
    }
    const events = records.map((record) => record.event?.type).filter((type) => type !== undefined)
    const page = JSON.stringify(records)
    return JSON.stringify({
      provider: selection.provider,
      model: selection.model,
      // \`request/header\` is written when the call leaves for the gateway, and
      // \`assistant/message\` only when one came back whole.
      requested: events.includes("request/header"),
      answered: events.includes("assistant/message"),
      code: (/"code":"([A-Z_]+)"/.exec(page) ?? [null, null])[1],
      // Event types only: the log also carries the workspace path and whatever the model
      // said, and a public CI log is not the place for either.
      events: Array.from(new Set(events)),
    })
  })()`

  return await evaluateCiSmokeJson(target, expression, 150_000) as CiSmokeFreeModelTurn
}

/**
 * Hold the build to shipping a credential its own free routes accept — and to nothing
 * else. A gateway that answers 400, rate-limits, or drops the stream is the model being
 * unstable, which no smoke can hold a build to; a 401 is the product shipping a key that
 * cannot buy the models it ships as the default.
 */
export function assertCiSmokeFreeModelTurn(turn: CiSmokeFreeModelTurn) {
  const failures = [
    turn.provider.startsWith("opencode")
      ? null
      : `the shipped default model is ${turn.provider}/${turn.model}, not an OpenCode Free route`,
    turn.requested
      ? null
      : `${turn.model} never reached the gateway: ${turn.events.join(", ") || "no events"}`,
    turn.code === "AUTH"
      ? `${turn.model} was rejected as unauthenticated on the seeded free-tier credential`
      : null,
  ].filter((failure): failure is string => failure !== null)

  if (failures.length) throw new Error(`DSH free-model turn failed:\n- ${failures.join("\n- ")}`)
}

async function evaluateCiSmokeJson(target: CdpTarget, expression: string, timeoutMs = 20_000) {
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("DSH CDP target does not expose a WebSocket debugger URL")
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the DSH product CDP evaluation")), timeoutMs)
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

export async function inspectCiSmokePersistence(target: CdpTarget, sessionId: string, dshHome: string, listedBefore: string[] = [], appLog: string[] = []) {
  const expectedSessionId = JSON.stringify(sessionId)
  const expression = `(async () => {
    const call = async (method, args) => {
      const request = { type: "client-request", rpcId: crypto.randomUUID(), method, payload: { args } }
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
    const sessions = (await call("session/list", { _request: {} })).items
    return JSON.stringify(sessions.map((session) => session.sessionId))
  })()`
  const restored = await evaluateCiSmokeJson(target, expression) as string[]
  if (restored.includes(sessionId)) return

  // The process that wrote is gone and only the disk is left, so the message has to carry the
  // scene: it is the sessions plus the home listing that separate "never written" from "not read
  // back".
  throw new Error([
    `DSH session ${sessionId} did not survive desktop restart`,
    `sessions before restart: ${listedBefore.length ? listedBefore.join(", ") : "(none)"}`,
    `sessions after restart: ${restored.length ? restored.join(", ") : "(none)"}`,
    `DSH home contents:\n${describeDirectory(dshHome)}`,
    `first app log tail:\n${appLog.length ? appLog.map((line) => `  ${line}`).join("\n") : "  (empty)"}`,
  ].join("\n"))
}

// session.create returns before the session is durable, and restarting the app
// before the write lands loses it — that is what the Windows job kept catching,
// including through a graceful before-quit shutdown. So do not restart until the
// session is actually on disk; a timeout here says the app never made it
// durable, which is the failure worth reporting rather than sleeping past.
async function waitForSessionOnDisk(dshHome: string, sessionId: string, timeoutMs = 15_000) {
  const sessions = join(dshHome, "sessions")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sessionBytesOnDisk(sessions, sessionId) > 0) return
    await delay(100)
  }
  throw new Error([
    `DSH session ${sessionId} never reached disk within ${timeoutMs}ms`,
    `sessions tree:\n${describeDirectory(sessions)}`,
  ].join("\n"))
}

// DSH creates the session directory before it writes the log into it, so the
// directory existing proves nothing — wait for actual bytes. This polls while
// the app is running, and DSH publishes through `<file>.<hex>.tmp` siblings it
// links and then unlinks, so a name read here can be gone by the time we stat
// it: ask for the stat without the throw.
function sessionBytesOnDisk(sessions: string, sessionId: string) {
  if (!existsSync(sessions)) return 0
  return readdirSync(sessions)
    .map((workspace) => join(sessions, workspace, sessionId))
    .flatMap((dir) => (existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []))
    .map((file) => statSync(file, { throwIfNoEntry: false }))
    .reduce((total, stats) => total + (stats?.isFile() ? stats.size : 0), 0)
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

export function assertCiSmokeProduct(snapshot: CiSmokeProductSnapshot, platform: NodeJS.Platform = process.platform) {
  // Assert relationships, never a height: that number is owned by Chromium on Windows and by the
  // main process on macOS. frameless is read from window-options, a different source than the
  // rendered drag strip, so the two diverging goes red.
  const frameless = "titleBarStyle" in dshTitleBarOptions(platform)
  const titlebarInsetsMatchPlatform = platform === "darwin"
    ? snapshot.titlebarInsetLeft > 0 && snapshot.titlebarInsetRight === 0
    : platform === "win32"
      ? snapshot.titlebarInsetLeft + snapshot.titlebarInsetRight > 0
      : snapshot.titlebarInsetLeft === 0 && snapshot.titlebarInsetRight === 0
  const failures = [
    snapshot.sidebarExpandedBrandHidden ? null : "expanded sidebar still renders the duplicate PawWork brand action",
    snapshot.sidebarCollapsedBrandHidden ? null : "collapsed sidebar still renders the duplicate DSH brand action",
    frameless === snapshot.titlebarStripHeight > 0
      ? null
      : `frameless=${frameless} but the titlebar drag strip is ${snapshot.titlebarStripHeight}px`,
    snapshot.titlebarStripDraggable ? null : "titlebar strip is not a drag region",
    snapshot.contentInsetHeight === 0 ? null : `web content still has a ${snapshot.contentInsetHeight}px full-width titlebar inset`,
    titlebarInsetsMatchPlatform
      ? null
      : `titlebar edge insets do not match ${platform}: left=${snapshot.titlebarInsetLeft}px right=${snapshot.titlebarInsetRight}px`,
    snapshot.windowsInsetMatchesDocumentDirection
      ? null
      : `Windows titlebar inset is on the wrong edge for the document direction`,
    snapshot.windowsBrowseDirectoryPickerWorked
      ? null
      : "Windows did not create the smoke workspace through the in-app browse directory picker",
    snapshot.expandedNewSessionFollowsTitlebar
      ? null
      : "expanded New session action leaves an empty brand-row gap below the titlebar",
    Object.values(snapshot.sidebarPrimaryActionCenterOffsets).every((offset) => offset !== null && Math.abs(offset) <= 1)
      ? null
      : `expanded and collapsed sidebar primary-action center offsets are ${JSON.stringify(snapshot.sidebarPrimaryActionCenterOffsets)}`,
    snapshot.collapsedSidebarFullyMergesWithContent
      ? null
      : "collapsed sidebar does not fully merge into the content surface",
    Object.values(snapshot.sessionHeaderComposerLeftAlignmentOffset)
      .every((offset) => offset !== null && offset <= 1)
      ? null
      : `session header and composer left-edge offsets are ${JSON.stringify(snapshot.sessionHeaderComposerLeftAlignmentOffset)}`,
    Object.values(snapshot.sessionHeaderRightBoundaryIntrusion)
      .every((intrusion) => intrusion !== null && intrusion <= 1)
      ? null
      : `session header right-boundary intrusions are ${JSON.stringify(snapshot.sessionHeaderRightBoundaryIntrusion)}`,
    snapshot.sessionHeaderDividerHidden
      ? null
      : "session header divider is visible",
    snapshot.collapsedSessionContentAlignmentOffset !== null && snapshot.collapsedSessionContentAlignmentOffset <= 1
      ? null
      : `collapsed session title and tabs are ${snapshot.collapsedSessionContentAlignmentOffset ?? "an unknown distance"}px out of alignment`,
    snapshot.collapsedSessionTitleGap !== null && snapshot.collapsedSessionTitleGap >= 8
      ? null
      : `collapsed session title leaves only ${snapshot.collapsedSessionTitleGap ?? "an unknown"}px after the sidebar toggle`,
    snapshot.sidebarCollapseMotionMatchesPreference
      ? null
      : "sidebar collapse motion does not match the user's motion preference",
    snapshot.expandedNativeControlOverlaps.length === 0
      ? null
      : `expanded controls overlap native window controls: ${snapshot.expandedNativeControlOverlaps.join(", ")}`,
    snapshot.collapsedNativeControlOverlaps.length === 0
      ? null
      : `collapsed controls overlap native window controls: ${snapshot.collapsedNativeControlOverlaps.join(", ")}`,
    snapshot.cursorProbeCaught.length === 2
      ? null
      : `the cursor probe caught ${snapshot.cursorProbeCaught.length}/2 planted mismatches (${snapshot.cursorProbeCaught.join(", ") || "nothing"}) and cannot be trusted`,
    snapshot.cursorMismatches.length === 0
      ? null
      : `cursor does not match link status on: ${snapshot.cursorMismatches.join(", ")}`,
    snapshot.heroMarkVisible ? null : "PawWork hero brand mark is not rendered",
    snapshot.heroHeadlineOverridden ? null : "hero headline fell back to DSH copy",
    snapshot.heroPreviewBadgeHidden ? null : "DSH preview badge is still visible on the hero",
    snapshot.heroMarkHeadlineOffset <= 1 ? null : `hero mark sits ${snapshot.heroMarkHeadlineOffset.toFixed(1)}px off the headline centre`,
    snapshot.automationSettingsEntryVisible ? null : "Automation Settings entry is not visible",
    snapshot.updateSettingsEntryVisible ? null : "Software Update settings entry is not visible",
    snapshot.updateSectionVisible ? null : "Software Update section did not open",
    snapshot.updateSectionReportsStatus ? null : "Software Update section shows no status from the updater bridge",
    snapshot.webSearchCardVisible ? null : "PawWork web search settings card is not in the Plugins section",
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
    snapshot.automationDatePopoutWorks ? null : "Automation date picker is not a popout inside the window",
    snapshot.automationDateEscapeCloses ? null : "Automation date picker does not close on Escape",
    snapshot.sidebarToggleCount === 1 ? null : `expected one PawWork sidebar toggle, found ${snapshot.sidebarToggleCount}`,
    snapshot.sidebarCollapsed ? null : "PawWork sidebar toggle did not collapse the sidebar",
    snapshot.sidebarExpandToggleCount === 1 ? null : `expected the same single PawWork toggle after collapse, found ${snapshot.sidebarExpandToggleCount}`,
    snapshot.sidebarExpandToggleUsable ? null : "PawWork sidebar toggle is not visibly clickable",
    snapshot.sidebarExpandToggleHasContent ? null : "PawWork sidebar toggle renders without its icon",
    snapshot.sidebarExpandedAgain ? null : "PawWork sidebar toggle did not reopen the sidebar",
    snapshot.freeProviderActive ? null : "OpenCode Free provider is not active",
    snapshot.v1SessionImported ? null : "V1 session was not imported into DSH",
    snapshot.v1SessionVisibleInSidebar ? null : "Imported V1 session never appeared in the sidebar without a reload",
    ["office-docx", "office-pdf", "office-pptx", "office-xlsx"].every((name) => snapshot.skillNames.includes(name))
      ? null
      : `bundled Office skills are incomplete: ${snapshot.skillNames.join(", ")}`,
  ].filter((failure): failure is string => failure !== null)

  if (failures.length) throw new Error(`DSH product smoke failed:\n- ${failures.join("\n- ")}`)
}

export function resolveCiSmokeReadyFile(homeDir: string, options: { channel?: PawWorkChannel; mode?: SmokeMode } = {}) {
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

function watchChildLogs(child: SmokeChild) {
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
  child: SmokeChild,
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
      env: buildSmokeEnv(homeDir, process.env, options),
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

// Ask the window to close, the way a user quits: window-all-closed → app.quit()
// → before-quit → DshLifecycle.stop(), which is where DSH state reaches disk.
// window.close() tears the page down mid-call, so defer it past the reply or the
// evaluation never returns.
async function closeAppWindow(target: CdpTarget) {
  await evaluateCiSmokeJson(target, `(() => {
    setTimeout(() => window.close(), 0)
    return JSON.stringify(true)
  })()`).catch(() => undefined)
}

// Signals do the job wherever they exist: the app handles SIGTERM by calling
// app.quit(). Windows has none — child.kill is TerminateProcess on this one PID
// — so the app never reaches before-quit and the sidecar is shot mid-flush.
// There, ask through the window instead; the kill below stays as the fallback.
async function stopChild(child: SmokeChild, closeWindow?: () => Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null) return

  if (process.platform === "win32" && closeWindow !== undefined) {
    await closeWindow()
    // before-quit gives the sidecar up to 10s to shut down; outwait it.
    const closed = await Promise.race([once(child, "exit").then(() => "exit"), delay(15_000).then(() => "timeout")])
    if (closed === "exit") {
      console.log(`CI smoke closed desktop app: code=${child.exitCode} signal=${child.signalCode}`)
      return
    }
  }

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
  // Only the raw mode runs the built bundle; a packaged run carries its own.
  if (target.mode === "raw") {
    const stale = staleMainEntry()
    if (stale !== undefined) {
      throw new Error(
        stale === null
          ? "Build the desktop app first — there is no out/main/index.js. Run: pnpm run build"
          : `Build the desktop app first — ${stale} is newer than out/main/index.js. Run: pnpm run build`,
      )
    }
  }
  const homeDir = mkdtempSync(join(tmpdir(), "pawwork-ci-smoke-"))
  const dshHome = dshHomeForSmoke(homeDir, target)
  // Seeded in the legacy home, asserted in the new one: the automation below has
  // to survive the migration to reach the assertions after the restart, so a
  // migration that stopped running would fail the smoke rather than pass quietly.
  const legacyDshHome = join(homeDir, appIdForSmoke(target.channel, target.mode), "dsh")
  const v1Database = join(homeDir, "v1", "pawwork.db")
  createCiSmokeV1Fixture(v1Database, homeDir)
  mkdirSync(legacyDshHome, { recursive: true })
  writeFileSync(join(legacyDshHome, "automations.json"), `${JSON.stringify({
    schema: 1,
    nextDefinition: 2,
    nextRun: 1,
    definitions: [{
      id: CI_SMOKE_MIGRATED_AUTOMATION_ID,
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
    }, {
      // A recurring automation cannot become a one-shot, so the date field only exists on an
      // automation that was created as one. It stays second: the probes above open the first row.
      id: CI_SMOKE_ONESHOT_AUTOMATION_ID,
      title: "Smoke one-shot automation",
      prompt: "Verify the Automation date field.",
      revision: 1,
      paused: true,
      context: "fresh",
      cwd: homeDir,
      model: { provider: "opencode", model: "deepseek-v4-flash-free" },
      timezone: "UTC",
      createdAt: 2,
      updatedAt: 2,
      kind: "oneshot",
      fireAt: Date.now() + 30 * 86_400_000,
    }],
    runs: [],
  }, null, 2)}\n`, { mode: 0o600 })
  const cdpPort = await resolveCiSmokeCdpPort(process.env)
  const { child, spawnError } = launchApp(homeDir, target, { cdpPort, v1Database })
  const logs = watchChildLogs(child)
  let product: CiSmokeProductSnapshot | undefined
  let cdpTarget: CdpTarget | undefined
  let firstAppLog: string[] = []

  try {
    await waitForCiSmokeReady(homeDir, target, child, spawnError, logs.recent)
    if (cdpPort !== undefined) {
      cdpTarget = await probeCiSmokeCdpTarget(cdpPort)
      product = await inspectCiSmokeProduct(cdpTarget, homeDir)
      if (child.pid === undefined && process.env.PAWWORK_CI_SCREENSHOT_PATH !== undefined) {
        throw new Error("Cannot capture the Windows app without its process ID")
      }
      if (child.pid !== undefined) {
        captureWindowsAppScreenshot(process.platform, child.pid, process.env.PAWWORK_CI_SCREENSHOT_PATH)
      }
      assertCiSmokeProduct(product)
      console.log("CI smoke verified DSH product UI, free-model routing, and bundled skills")
      const turn = await inspectCiSmokeFreeModelTurn(cdpTarget, product.sessionId)
      assertCiSmokeFreeModelTurn(turn)
      console.log(`CI smoke free-model turn on ${turn.provider}/${turn.model}: ${
        turn.answered ? "answered" : `no answer (${turn.code ?? "no failure code"}) — the model, not the credential`
      }`)
      await waitForSessionOnDisk(dshHome, product.sessionId)
      console.log(`CI smoke sessions before shutdown: ${product.sessionIdsBeforeRestart.join(", ") || "(none)"}`)
      console.log(`CI smoke session files before shutdown:\n${describeDirectory(join(dshHome, "sessions"))}`)
    }
  } finally {
    // After stopChild, not before: the shutdown path is exactly where the session
    // write can be lost, so its logs are the ones the persistence failure needs.
    await stopChild(child, cdpTarget === undefined ? undefined : () => closeAppWindow(cdpTarget as CdpTarget))
    firstAppLog = [...logs.recent]
    logs.close()
  }

  if (product !== undefined) {
    rmSync(resolveCiSmokeReadyFile(homeDir, { channel: target.channel, mode: target.mode }), { force: true })
    const restartPort = await allocateCiSmokeCdpPort()
    const restarted = launchApp(homeDir, target, { cdpPort: restartPort, v1Database })
    const restartLogs = watchChildLogs(restarted.child)
    let restartTarget: CdpTarget | undefined
    try {
      await waitForCiSmokeReady(homeDir, target, restarted.child, restarted.spawnError, restartLogs.recent)
      restartTarget = await probeCiSmokeCdpTarget(restartPort)
      await inspectCiSmokePersistence(restartTarget, product.sessionId, dshHome, product.sessionIdsBeforeRestart, firstAppLog)
      console.log("CI smoke verified DSH session persistence after restart")
    } finally {
      restartLogs.close()
      await stopChild(restarted.child, restartTarget === undefined ? undefined : () => closeAppWindow(restartTarget as CdpTarget))
    }
    const automationDocument = JSON.parse(readFileSync(join(dshHome, "automations.json"), "utf8")) as {
      definitions?: Array<{ id?: string }>
    }
    if (!automationDocument.definitions?.some((definition) => definition.id === CI_SMOKE_IMPORTED_AUTOMATION_ID)) {
      throw new Error(`V1 Automation ${CI_SMOKE_IMPORTED_AUTOMATION_ID} did not survive desktop restart`)
    }
    // Seeded in the legacy home, read back from the dotdir home: the only way
    // it got here is the migration, so dropping the migration fails the smoke.
    if (!automationDocument.definitions?.some((definition) => definition.id === CI_SMOKE_MIGRATED_AUTOMATION_ID)) {
      throw new Error(`Automation ${CI_SMOKE_MIGRATED_AUTOMATION_ID} seeded in ${legacyDshHome} did not reach ${dshHome}`)
    }
    console.log("CI smoke verified V1 session and Automation migration after restart")
  }
}

if (import.meta.main) {
  await main()
}
