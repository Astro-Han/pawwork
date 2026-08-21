import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell, type Event } from "electron"
import contextMenu from "electron-context-menu"
import pkg from "electron-updater"
import { PAWWORK_APP } from "./app-identity"
import {
  CHANNEL,
  DOWNLOAD_PUBLIC_BASE,
  UPDATE_CHANNEL,
  UPDATE_GITHUB_OWNER,
  UPDATE_GITHUB_REPO,
  UPDATER_ACTIVE,
} from "./constants"
import { ciSmokeCdpSwitches } from "./ci-smoke-cdp"
import { pickConversationFiles } from "./dsh-file-input"
import { createDshMenu } from "./dsh-menu"
import {
  buildDshEnvironment,
  dshFileInputPreload,
  prepareDshProductHome,
  resolveDshPackagePath,
  resolveProductResources,
} from "./dsh-product-home"
import { describeExit, launchDshSidecar, type DshSidecar } from "./dsh-sidecar"
import { migrateDshHome, resolveDshHome } from "./pawwork-home"
import { initLogging } from "./logging"
import { detectSystemMenuLocale } from "./menu-labels"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"
import {
  STARTUP_SCHEME,
  STARTUP_URL,
  startupDiagnosis,
  startupFailureReport,
  startupPageHtml,
  type StartupAction,
  type StartupPageState,
} from "./startup-page"
import type { StartupFailureReason } from "./startup-page-labels"
import { PAWWORK_GITHUB_ISSUE_URL } from "./support-links"
import { createUpdaterController } from "./updater"
import { pendingUpdateCacheDir } from "./updater-cache"
import { updaterDialogLabels } from "./updater-dialog-labels"
import { createMainWindow, navigateWindow, setDockIcon } from "./windows"

contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

if (process.platform === "darwin") {
  try {
    process.chdir(homedir())
  } catch {}
}

const CI_SMOKE_HOME = process.env.PAWWORK_CI_SMOKE_HOME
const CI_SMOKE_ENABLED = process.env.PAWWORK_CI_SMOKE === "true"
const UPDATE_FEED_TIMEOUT_MS = 10_000
const UPDATE_CHANNEL_FILE = process.platform === "win32" ? `${UPDATE_CHANNEL}.yml` : `${UPDATE_CHANNEL}-mac.yml`
const LATEST_RELEASE_URL = `https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`

const userDataRoot = CI_SMOKE_HOME ?? app.getPath("appData")
const appChannel = app.isPackaged ? CHANNEL : "dev"
const appIdentity = PAWWORK_APP[appChannel]
app.setName(appIdentity.name)
if (CI_SMOKE_HOME) app.setPath("appData", CI_SMOKE_HOME)
app.setPath("userData", join(userDataRoot, appIdentity.id))
if (CI_SMOKE_HOME) app.setPath("logs", join(app.getPath("userData"), "logs"))

const CI_SMOKE_READY_FILE = join(app.getPath("userData"), "ci-smoke-ready.json")
const { autoUpdater } = pkg
const logger = initLogging()
const menuLocale = detectSystemMenuLocale(app.getLocale())

// Pure path work over values that never change for the life of the process, so
// there is nothing to sequence and nothing that can be read before it is set.
const productResources = resolveProductResources({
  appPath: app.isPackaged ? app.getAppPath() : join(dirname(fileURLToPath(import.meta.url)), "../.."),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
})
const fileInputPreload = dshFileInputPreload(productResources.dsh)

let dshUrl: string | undefined
// DSH states the cause and the fix on its own stderr before it exits, and the
// window has no other copy of it: once DSH is gone, its stdio is gone with it.
// Keeping the tail costs a few kilobytes.
const DSH_OUTPUT_TAIL_CHARS = 4_000
let dshOutputTail = ""
let startupState: StartupPageState = { phase: "starting" }
let dshAttempt: Promise<void> | undefined
let sidecar: DshSidecar | undefined
let sidecarShutdown: Promise<void> | undefined
let gracefulQuitStarted = false
let gracefulQuitReady = false
let currentProgress: number | null = null

function buildUpdateFeeds(): FeedTarget[] {
  return [
    r2Feed(DOWNLOAD_PUBLIC_BASE, UPDATE_CHANNEL, UPDATE_CHANNEL_FILE),
    githubFeed(UPDATE_GITHUB_OWNER, UPDATE_GITHUB_REPO, UPDATE_CHANNEL, UPDATE_CHANNEL_FILE),
  ]
}

const updateFeed = createUpdateFeed({
  feeds: buildUpdateFeeds(),
  setFeedURL: (options) => autoUpdater.setFeedURL(options),
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  downloadUpdate: () => autoUpdater.downloadUpdate(),
  timeoutMs: UPDATE_FEED_TIMEOUT_MS,
  log: (message, data) => logger.log(message, data),
  error: (message, error) => logger.error(message, error),
})

const updater = createUpdaterController({
  enabled: UPDATER_ACTIVE,
  currentVersion: () => app.getVersion(),
  checkForUpdates: () => updateFeed.check(),
  downloadUpdate: () => updateFeed.download(),
  clearPendingUpdate,
  quitAndInstall: () => {
    void shutdownSidecar().finally(() => autoUpdater.quitAndInstall())
  },
  log: (message, data) => logger.log(message, data),
  error: (message, error) => logger.error(message, error),
})

logger.log("app starting", { version: app.getVersion(), packaged: app.isPackaged })
setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  for (const [name, value] of ciSmokeCdpSwitches(process.env)) app.commandLine.appendSwitch(name, value)

  if (!CI_SMOKE_ENABLED && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  ipcMain.handle("pawwork:pick-conversation-files", (event) => {
    if (!dshUrl) throw new Error("Cannot pick files before DSH is ready")
    const owner = BrowserWindow.fromWebContents(event.sender)
    return pickConversationFiles(dshUrl, event.senderFrame?.url ?? "", (options) =>
      owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
    )
  })

  app.on("second-instance", () => focusMainWindow(true))
  app.on("open-url", (event: Event) => {
    event.preventDefault()
    focusMainWindow(true)
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
  app.on("before-quit", (event) => {
    if (gracefulQuitReady) return
    event.preventDefault()
    if (gracefulQuitStarted) return
    gracefulQuitStarted = true

    const finish = () => {
      if (gracefulQuitReady) return
      gracefulQuitReady = true
      app.quit()
    }
    const timeout = setTimeout(() => {
      logger.error("graceful DSH shutdown timed out, forcing quit")
      finish()
    }, 10_000)
    void shutdownSidecar()
      .catch((error) => logger.error("DSH shutdown failed", error))
      .finally(() => {
        clearTimeout(timeout)
        finish()
      })
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit())

  // Standard and secure so the page gets an ordinary origin: without it the
  // scheme has no host, `startsWith(STARTUP_URL)` has nothing stable to match,
  // and the document lands in an opaque origin the guard cannot name.
  protocol.registerSchemesAsPrivileged([{ scheme: STARTUP_SCHEME, privileges: { standard: true, secure: true } }])

  void app
    .whenReady()
    .then(() => {
      app.setAsDefaultProtocolClient("pawwork")
      setDockIcon()
      setupAutoUpdater()
      // Served on every load rather than cached, so re-rendering a state change
      // is a reload of the page already on screen.
      protocol.handle(STARTUP_SCHEME, () =>
        Promise.resolve(
          new Response(startupPageHtml(menuLocale, startupState), {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        ),
      )

      // The window is what makes every DSH failure reportable, so it opens
      // before anything that can fail. The menu goes up with it: it is where the
      // issue link lives, and it used to be built only after a successful start.
      openMainWindow()
      wireMenu()
      void runDsh()
    })
    .catch((error) => {
      // Nothing here waits on DSH any more; what is left is Electron's own setup,
      // and a failure in it leaves no window to report through.
      logger.error("app initialization failed", error)
      app.exit(1)
    })
}

/**
 * Start DSH, and put whatever happens on screen.
 *
 * One attempt at a time: the retry button is a link the user can click twice
 * before the first click has spawned anything.
 * @returns the attempt in flight.
 */
function runDsh() {
  dshAttempt ??= attemptDsh().finally(() => {
    dshAttempt = undefined
  })
  return dshAttempt
}

async function attemptDsh() {
  await stopActiveSidecar().catch((error) => logger.error("DSH shutdown failed", error))
  // A retry reports on itself, not on the attempt the user just tried to fix.
  dshOutputTail = ""
  startupState = { phase: "starting" }
  showStartupPage()
  try {
    dshUrl = await startDsh()
  } catch (error) {
    logger.error("DSH sidecar failed to start", error)
    failStartup("startup", error)
    return
  }
  // What DSH said while booting is not what it will say when it dies, and the
  // tail is what the failure page quotes.
  dshOutputTail = ""
  for (const win of liveWindows()) if (isOnStartupPage(win)) navigateWindow(win, dshUrl)
}

/**
 * Hand the failure back to the user, in the window, with a way out.
 *
 * The same surface serves a runtime that never started and one that died
 * mid-session: from the user's seat they are the same event — PawWork is not
 * working and the app has to say why — and the retry is the same respawn.
 * @param reason - which of the two happened, for the copy.
 * @param error - whatever the attempt rejected with.
 */
function failStartup(reason: StartupFailureReason, error: unknown) {
  dshUrl = undefined
  // A smoke run has nobody to click retry, and its runner already reads a dead
  // process as the failure it is. Rendering instead would hold the app open
  // until the runner's own timeout.
  if (CI_SMOKE_ENABLED) {
    app.exit(1)
    return
  }
  startupState = {
    phase: "failed",
    reason,
    diagnosis: startupDiagnosis(error, dshOutputTail),
    output: dshOutputTail,
    logPath: logger.transports.file.getFile().path,
    copied: false,
  }
  showStartupPage()
}

function handleStartupAction(action: StartupAction) {
  switch (action) {
    case "retry":
      void runDsh()
      return
    case "report-issue":
      void shell.openExternal(PAWWORK_GITHUB_ISSUE_URL)
      return
    case "show-log":
      if (startupState.phase === "failed") shell.showItemInFolder(startupState.logPath)
      return
    case "copy-details":
      if (startupState.phase !== "failed") return
      clipboard.writeText(startupFailureReport(startupState, menuLocale))
      startupState = { ...startupState, copied: true }
      showStartupPage()
      return
  }
}

function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
}

function isOnStartupPage(win: BrowserWindow) {
  return win.webContents.getURL().startsWith(STARTUP_URL)
}

function showStartupPage() {
  for (const win of liveWindows()) {
    if (isOnStartupPage(win)) win.webContents.reload()
    else navigateWindow(win, STARTUP_URL)
  }
}

async function startDsh() {
  // The migration is the argument rather than a preceding statement, so it
  // cannot be reordered: prepareDshProductHome creates and populates whatever
  // home it is handed, and a migration running after it would read that overlay
  // as a home a newer build had written and leave the real data in userData.
  const product = prepareDshProductHome({
    // CI_SMOKE_HOME, not just homedir(): buildSmokeEnv can only set HOME, and
    // homedir() reads USERPROFILE on Windows, where a smoke run would then
    // migrate the real user profile.
    productHome: migrateDshHome({
      home: resolveDshHome({ channel: appChannel, homeRoot: CI_SMOKE_HOME ?? homedir() }),
      legacyHome: join(app.getPath("userData"), "dsh"),
      onEvent: (message, detail) => logger.log(message, detail),
    }),
    resources: productResources.dsh,
  })
  const require = createRequire(import.meta.url)
  const dshPackage = resolveDshPackagePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    resolveDevelopmentPackage: () => require.resolve("@deepseek-ai/dsh/package.json"),
  })

  logger.log("spawning DSH sidecar")
  const started = await launchDshSidecar({
    executable: process.execPath,
    dshBin: join(dirname(dshPackage), "lib", "bin.js"),
    sidecarPreload: pathToFileURL(product.sidecarPreload).href,
    productHome: product.home,
    productPatch: product.patch,
    toolsDir: join(dirname(productResources.dsh), "tools"),
    env: buildDshEnvironment(productResources.skills),
    timeoutMs: 30_000,
    spawn: (executable, args, options) => spawn(executable, args, options),
    onStdout: (chunk) => logger.log("DSH stdout", { chunk: chunk.trimEnd() }),
    onStderr: (chunk) => {
      dshOutputTail = (dshOutputTail + chunk).slice(-DSH_OUTPUT_TAIL_CHARS)
      logger.error("DSH stderr", chunk.trimEnd())
    },
    onError: (error) => logger.error("DSH sidecar process error", error),
  })
  sidecar = started
  void started.exited.then((code) => {
    // A stop we asked for clears the slot before it waits, so an exit that still
    // owns it is one nobody asked for. It used to take the app down with it.
    if (sidecar !== started) return
    sidecar = undefined
    logger.error("DSH sidecar exited", { code })
    failStartup("crash", new Error(`DSH exited ${describeExit(code)}`))
  })
  return started.url
}

function openMainWindow() {
  const win = createMainWindow({
    preload: fileInputPreload,
    dshUrl: () => dshUrl,
    onStartupAction: handleStartupAction,
  })
  if (currentProgress !== null) win.setProgressBar(currentProgress)
  if (CI_SMOKE_ENABLED) {
    // The first load is the startup page now, so readiness is the load that
    // lands on DSH — not the first one to finish.
    win.webContents.on("did-finish-load", () => {
      if (!dshUrl || !win.webContents.getURL().startsWith(dshUrl)) return
      mkdirSync(dirname(CI_SMOKE_READY_FILE), { recursive: true })
      writeFileSync(CI_SMOKE_READY_FILE, JSON.stringify({ readyAt: new Date().toISOString() }), "utf8")
    })
  }
  return win
}

function focusMainWindow(openIfMissing = false) {
  const [existing] = liveWindows()
  const win = existing ?? (openIfMissing ? openMainWindow() : undefined)
  win?.show()
  win?.focus()
}

function wireMenu() {
  createDshMenu({
    checkForUpdates: () => void checkForUpdates(true),
    newWindow: openMainWindow,
    relaunch: () => {
      void shutdownSidecar().finally(() => {
        app.relaunch()
        app.exit(0)
      })
    },
  }, menuLocale)
}

function applyProgressBar(value: number) {
  for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(value)
}

function clearProgressBar() {
  currentProgress = null
  applyProgressBar(-1)
}

// No feed is configured here: every check runs through updateFeed, which probes
// the feeds in order and points electron-updater at the one it picked. Setting
// the first feed at startup only duplicated that choice — with a worse fallback
// — and the packaged app-update.yml already covers anything that reads a feed
// before the first check.
function setupAutoUpdater() {
  if (!UPDATER_ACTIVE) return
  autoUpdater.logger = logger
  autoUpdater.channel = UPDATE_CHANNEL
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = process.platform !== "darwin"

  autoUpdater.on("download-progress", (info) => {
    currentProgress = info.percent / 100
    applyProgressBar(currentProgress)
  })
  autoUpdater.on("update-downloaded", clearProgressBar)
  autoUpdater.on("update-not-available", clearProgressBar)
  autoUpdater.on("update-cancelled", clearProgressBar)
  autoUpdater.on("error", (error) => {
    logger.error("updater error", error)
    clearProgressBar()
  })
}

async function checkForUpdates(alertOnFail: boolean) {
  const labels = updaterDialogLabels(menuLocale)
  const result = await updater.check()
  if (result.status === "busy" || result.status === "disabled") {
    if (alertOnFail) await dialog.showMessageBox({ type: "info", ...labels[result.status] })
    return
  }
  if (result.status === "failed") {
    if (!alertOnFail) return
    const response = await dialog.showMessageBox({
      type: "error",
      title: labels.failed.title,
      message: labels.failed.reasonCopy[result.reason],
      detail: [result.message, labels.failed.currentVersionUnaffected].filter(Boolean).join("\n\n"),
      buttons: [labels.failed.buttons.retry, labels.failed.buttons.openDownloadPage, labels.failed.buttons.later],
      defaultId: 0,
      cancelId: 2,
    })
    if (response.response === 0) await checkForUpdates(alertOnFail)
    if (response.response === 1) await shell.openExternal(LATEST_RELEASE_URL)
    return
  }
  if (result.status === "none") {
    if (alertOnFail) await dialog.showMessageBox({ type: "info", ...labels.none })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    title: labels.ready.title,
    message: labels.ready.message(result.version),
    buttons: labels.ready.buttons,
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response !== 0) {
    updater.dismissReady()
    return
  }

  try {
    const started = updater.install()
    if (!started) await dialog.showMessageBox({ type: "info", ...labels.none })
  } catch (error) {
    logger.error("install update failed", error)
    const failure = await dialog.showMessageBox({
      type: "error",
      title: labels.failed.title,
      message: labels.failed.installFailedMessage,
      detail: [error instanceof Error ? error.message : "", labels.failed.currentVersionUnaffected]
        .filter(Boolean)
        .join("\n\n"),
      buttons: [labels.failed.buttons.openDownloadPage, labels.failed.buttons.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (failure.response === 0) await shell.openExternal(LATEST_RELEASE_URL)
  }
}

// Memoised because quit can be reached from several directions at once; the
// stop itself is not, so a retry can start a fresh sidecar after it.
async function shutdownSidecar() {
  sidecarShutdown ??= stopActiveSidecar()
  await sidecarShutdown
}

async function stopActiveSidecar() {
  const active = sidecar
  sidecar = undefined
  if (active) await active.stop()
}

async function clearPendingUpdate() {
  await rm(pendingUpdateCacheDir(), { recursive: true, force: true })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  for (const key of ["NO_PROXY", "no_proxy"] as const) {
    const values = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    for (const host of loopback) if (!values.some((value) => value.toLowerCase() === host)) values.push(host)
    process.env[key] = values.join(",")
  }
}
