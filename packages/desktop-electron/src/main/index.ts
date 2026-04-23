import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer } from "node:net"
import os, { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Event } from "electron"
import { app, BrowserWindow, clipboard, dialog, shell } from "electron"
import pkg from "electron-updater"

import contextMenu from "electron-context-menu"
contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

// on macOS apps run in `/` which can cause issues with ripgrep
if (process.platform === "darwin") {
  try {
    process.chdir(homedir())
  } catch {}
}

process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

const APP_NAMES: Record<string, string> = {
  dev: "PawWork Dev",
  beta: "PawWork Beta",
  prod: "PawWork",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.pawwork.desktop.dev",
  beta: "ai.pawwork.desktop.beta",
  prod: "ai.pawwork.desktop",
}
const CI_SMOKE_HOME = process.env.PAWWORK_CI_SMOKE_HOME
const CI_SMOKE_ENABLED = process.env.PAWWORK_CI_SMOKE === "true"
const userDataRoot = CI_SMOKE_HOME ?? app.getPath("appData")

app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "PawWork Dev")
if (CI_SMOKE_HOME) {
  app.setPath("appData", CI_SMOKE_HOME)
}
app.setPath("userData", join(userDataRoot, app.isPackaged ? APP_IDS[CHANNEL] : "ai.pawwork.desktop.dev"))
if (CI_SMOKE_HOME) {
  // Keep smoke logs inside the isolated profile so release checks cannot read stale user logs.
  app.setPath("logs", join(app.getPath("userData"), "logs"))
}
const CI_SMOKE_READY_FILE = join(app.getPath("userData"), "ci-smoke-ready.json")
const { autoUpdater } = pkg

import type { DesktopContext, InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, FEEDBACK_FORM_URL, UPDATER_ENABLED } from "./constants"
import { createDesktopContextStore } from "./desktop-context-store"
import { errorMessage } from "./error"
import { createFeedbackHandler, feedbackDialogLabels } from "./feedback"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { filePath, initLogging, tail } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { type MenuLocale } from "./menu-labels"
import { readStoredMenuLocale, writeStoredMenuLocale } from "./menu-i18n"
import { getDefaultServerUrl, getWslConfig, setDefaultServerUrl, setWslConfig, spawnLocalServer } from "./server"
import { PAWWORK_RUNTIME } from "./runtime-namespace"
import { createUpdaterController } from "./updater"
import { pendingUpdateCacheDir } from "./updater-cache"
import { updaterDialogLabels } from "./updater-dialog-labels"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  registerRendererScheme,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import {
  registerWindowLifecycle,
  selectCommandWindow,
  selectNextMainWindow,
  shouldOpenWindowForExternalEvent,
  shouldQueueDeepLinks,
  takeQueuedDeepLinksForReadyWindow,
} from "./window-lifecycle"
import type { Server } from "virtual:opencode-server"

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let server: Server.Listener | null = null
const loadingComplete = defer<void>()
const deepLinkReadyWindows = new WeakSet<BrowserWindow>()
let menuLocale: MenuLocale = readStoredMenuLocale(app.getLocale())
const defaultDesktopContext = (): DesktopContext => ({
  directory: null,
  sessionID: null,
  route: "/",
  locale: menuLocale,
})
const desktopContexts = createDesktopContextStore(defaultDesktopContext)
const contextWindowCleanup = new Set<number>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()
const updater = createUpdaterController({
  enabled: UPDATER_ENABLED,
  currentVersion: () => app.getVersion(),
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  downloadUpdate: () => autoUpdater.downloadUpdate(),
  clearPendingUpdate: clearPendingUpdate,
  quitAndInstall: () => {
    killSidecar()
    autoUpdater.quitAndInstall()
  },
  log: (message, data) => logger.log(message, data),
  error: (message, error) => logger.error(message, error),
})

function diagnostics(context = currentDesktopContext()) {
  return {
    appVersion: app.getVersion(),
    channel: CHANNEL,
    packaged: app.isPackaged,
    updaterEnabled: UPDATER_ENABLED,
    platform: process.platform,
    osVersion: `${os.type()} ${os.release()}`,
    arch: process.arch,
    electronVersion: process.versions.electron,
    locale: context.locale,
    route: context.route,
    directory: context.directory,
    sessionID: context.sessionID,
    logPath: filePath(),
  }
}

async function sessionExport(context = currentDesktopContext()) {
  if (!context.sessionID) return { status: "none" as const }
  const ready = await serverReady.promise
  const sessionID = encodeURIComponent(context.sessionID)
  const url = new URL(`/session/${sessionID}/message`, ready.url)
  const headers: Record<string, string> = {}
  if (ready.username || ready.password) {
    headers.authorization = `Basic ${Buffer.from(`${ready.username ?? "opencode"}:${ready.password ?? ""}`).toString("base64")}`
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let res: Response
  try {
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error("session export timed out"))
      }, 10_000)
    })
    res = await Promise.race([fetch(url, { headers, signal: controller.signal }), timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  if (!res.ok) throw new Error(`session export failed: ${res.status}`)
  return {
    status: "ok" as const,
    info: context,
    messages: (await res.json()) as unknown[],
  }
}

function currentDesktopContext() {
  return desktopContexts.current(BrowserWindow.getFocusedWindow()?.id)
}

function normalizeDesktopContext(context: unknown): DesktopContext {
  const value = context && typeof context === "object" ? (context as Record<string, unknown>) : {}
  return {
    directory: typeof value.directory === "string" ? value.directory : null,
    sessionID: typeof value.sessionID === "string" ? value.sessionID : null,
    route: typeof value.route === "string" && value.route.length > 0 ? value.route : "/",
    locale: value.locale === "zh" ? "zh" : "en",
  }
}

function feedbackContext(context: unknown): DesktopContext {
  return context === undefined ? currentDesktopContext() : normalizeDesktopContext(context)
}

const reportProblem = createFeedbackHandler({
  feedbackUrl: FEEDBACK_FORM_URL,
  context: currentDesktopContext,
  confirm: async (context) => {
    const labels = feedbackDialogLabels(context === undefined ? menuLocale : feedbackContext(context).locale)
    const response = await dialog.showMessageBox({
      type: "warning",
      title: labels.title,
      message: labels.message,
      buttons: [labels.confirm, labels.cancel],
      defaultId: 0,
      cancelId: 1,
    })
    return response.response === 0
  },
  copy: (value) => clipboard.writeText(value),
  openExternal: (url) => {
    return shell.openExternal(url).then(() => undefined)
  },
  diagnostics: (context) => diagnostics(feedbackContext(context)),
  logTail: tail,
  sessionExport: (context) => sessionExport(feedbackContext(context)),
  onError: async (error) => {
    logger.error("problem report failed", error)
    const labels = feedbackDialogLabels(currentDesktopContext().locale)
    await dialog.showMessageBox({
      type: "error",
      title: labels.failedTitle,
      message: labels.failedMessage,
      detail: errorMessage(error),
    })
  },
})

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
})

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  registerRendererScheme()

  // CI smoke should not fail just because a local desktop instance already holds
  // the singleton lock on the runner or developer machine.
  if (!CI_SMOKE_ENABLED && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow({ openIfMissing: true })
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
    focusMainWindow({ openIfMissing: true })
  })

  registerWindowLifecycle({
    onWindowAllClosed: (listener) => app.on("window-all-closed", listener),
    onActivate: (listener) => app.on("activate", listener),
    quit: () => app.quit(),
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    openWindow: () => {
      if (isInitialized()) openMainWindow()
    },
    platform: process.platform,
  })

  app.on("before-quit", () => {
    killSidecar()
  })

  app.on("will-quit", () => {
    killSidecar()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecar()
      app.exit(0)
    })
  }

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("opencode")
    registerRendererProtocol()
    setDockIcon()
    setupAutoUpdater()
    await initialize()
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  const windowReady = mainWindow ? deepLinkReadyWindows.has(mainWindow) : false
  if (shouldQueueDeepLinks(Boolean(mainWindow), windowReady)) pendingDeepLinks.push(...urls)
  if (mainWindow && windowReady) sendDeepLinks(mainWindow, urls)
}

function flushPendingDeepLinksForReadyWindow(win: BrowserWindow | null) {
  if (!win || !deepLinkReadyWindows.has(win)) return
  const urls = takeQueuedDeepLinksForReadyWindow(pendingDeepLinks, true)
  if (urls.length) sendDeepLinks(win, urls)
}

function reportDeepLinkReady(win: BrowserWindow | null) {
  if (!win) return
  deepLinkReadyWindows.add(win)
  if (win !== mainWindow) return
  flushPendingDeepLinksForReadyWindow(win)
}

function isInitialized() {
  return initStep.phase === "done"
}

function focusMainWindow(options: { openIfMissing?: boolean } = {}) {
  if (!mainWindow && options.openIfMissing && shouldOpenWindowForExternalEvent(false, isInitialized())) openMainWindow()
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function openMainWindow() {
  const win = createMainWindow()
  mainWindow = win
  win.on("focus", () => syncMenuLocaleForWindow(win))
  win.on("closed", () => {
    if (mainWindow !== win) return
    mainWindow = selectNextMainWindow(win, BrowserWindow.getAllWindows())
    flushPendingDeepLinksForReadyWindow(mainWindow)
    syncMenuLocaleForWindow(mainWindow)
  })
  wireMenu()
  return win
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  if (step.phase === "done") logger.log("init done")
  initEmitter.emit("step", step)
}

async function initialize() {
  // The embedded server owns DB initialization. The desktop shell must not
  // block first launch on a migration progress event that the embedded runtime
  // does not emit.
  const needsMigration = false
  let overlay: BrowserWindow | null = null

  const port = await getSidecarPort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  logger.log("spawning sidecar", { url })
  const { listener, health } = await spawnLocalServer(hostname, port, password)
  server = listener
  serverReady.resolve({
    url,
    username: PAWWORK_RUNTIME.serverUsername,
    password,
  })

  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    await Promise.race([
      health.wait,
      delay(30_000).then(() => {
        throw new Error("Sidecar health check timed out")
      }),
    ]).catch((error) => {
      logger.error("sidecar health check failed", error)
    })

    logger.log("loading task finished")
  })()

  if (needsMigration) {
    const show = await Promise.race([loadingTask.then(() => false), delay(1_000).then(() => true)])
    if (show) {
      overlay = createLoadingWindow()
      await delay(1_000)
    }
  }

  await loadingTask
  setInitStep({ phase: "done" })

  if (overlay) {
    await loadingComplete.promise
  }

  openMainWindow()

  overlay?.close()
}

function focusedMenuLocale() {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return menuLocale
  return desktopContexts.current(focused.id).locale
}

function syncMenuLocaleForWindow(win: BrowserWindow | null) {
  if (!win) return
  const next = desktopContexts.current(win.id).locale
  if (next === menuLocale) return
  menuLocale = next
  writeStoredMenuLocale(next)
  wireMenu()
}

function wireMenu() {
  if (!mainWindow) return
  const commandWindow = () => selectCommandWindow(BrowserWindow.getFocusedWindow(), mainWindow)
  createMenu({
    trigger: (id) => {
      const win = commandWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => commandWindow()?.reload(),
    relaunch: () => {
      killSidecar()
      app.relaunch()
      app.exit(0)
    },
    newWindow: () => openMainWindow(),
    reportProblem: () => {
      void reportProblem()
    },
  }, focusedMenuLocale())
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getWindowConfig: () => ({
    updaterEnabled: UPDATER_ENABLED,
    wslEnabled: getWslConfig().enabled,
  }),
  consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  setBackgroundColor: (color) => setBackgroundColor(color),
  reportDeepLinkReady: (win) => reportDeepLinkReady(win),
  reportCiSmokeReady: () => reportCiSmokeReady(),
  setDesktopContext: (context, win) => {
    const next = normalizeDesktopContext(context)
    desktopContexts.set(win.id, next)
    if (!contextWindowCleanup.has(win.id)) {
      contextWindowCleanup.add(win.id)
      win.once("closed", () => {
        desktopContexts.delete(win.id)
        contextWindowCleanup.delete(win.id)
      })
    }
    if (BrowserWindow.getFocusedWindow()?.id === win.id) syncMenuLocaleForWindow(win)
  },
})

function killSidecar() {
  if (!server) return
  server.stop()
  server = null
}

function reportCiSmokeReady() {
  if (!CI_SMOKE_ENABLED) return
  mkdirSync(dirname(CI_SMOKE_READY_FILE), { recursive: true })
  writeFileSync(CI_SMOKE_READY_FILE, JSON.stringify({ readyAt: new Date().toISOString() }), "utf8")
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function clearPendingUpdate() {
  await rm(pendingUpdateCacheDir(), { recursive: true, force: true })
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = process.platform !== "darwin"
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    autoInstallOnAppQuit: autoUpdater.autoInstallOnAppQuit,
    currentVersion: app.getVersion(),
  })
}

async function checkUpdate() {
  const result = await updater.check()
  if (result.status === "ready") return { updateAvailable: true as const, status: result.status, version: result.version }
  if (result.status === "failed") {
    return { updateAvailable: false as const, status: result.status, reason: result.reason, message: result.message }
  }
  return { updateAvailable: false as const, status: result.status }
}

async function installUpdate() {
  const started = updater.install()
  if (!started) logger.log("install update skipped", { reason: "no ready update" })
  return started
}

async function checkForUpdates(alertOnFail: boolean) {
  const labels = updaterDialogLabels(currentDesktopContext().locale)
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (result.status === "busy") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      title: labels.busy.title,
      message: labels.busy.message,
    })
    return
  }
  if (result.status === "disabled") {
    logger.log("no update decision", { reason: "updates disabled" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      title: labels.disabled.title,
      message: labels.disabled.message,
    })
    return
  }
  if (result.status === "failed") {
    logger.log("no update decision", { reason: result.reason ?? "update check failed" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "error",
      message: result.message ?? labels.failed.fallbackMessage,
      title: labels.failed.title,
    })
    return
  }
  if (!result.updateAvailable) {
    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: labels.none.message,
      title: labels.none.title,
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: labels.ready.message(result.version),
    title: labels.ready.title,
    buttons: labels.ready.buttons,
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    try {
      const started = await installUpdate()
      if (!started) {
        await dialog.showMessageBox({
          type: "info",
          title: labels.none.title,
          message: labels.none.message,
        })
      }
    } catch (error) {
      logger.error("install update failed", error)
      await dialog.showMessageBox({
        type: "error",
        title: labels.failed.title,
        message: error instanceof Error ? error.message : labels.failed.fallbackMessage,
      })
    }
  } else {
    updater.dismissReady()
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
