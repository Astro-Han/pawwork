import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { app, BrowserWindow, dialog, ipcMain, shell, type Event } from "electron"
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
  prepareDshProductHome,
  resolveDshPackagePath,
  resolveProductResources,
} from "./dsh-product-home"
import { launchDshSidecar, type DshSidecar } from "./dsh-sidecar"
import { migrateDshHome, resolveDshHome, resolvePawWorkHomeRoot } from "./pawwork-home"
import { initLogging } from "./logging"
import { detectSystemMenuLocale } from "./menu-labels"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"
import { reportStartupFailure } from "./startup-failure"
import { PAWWORK_GITHUB_ISSUE_URL } from "./support-links"
import { createUpdaterController } from "./updater"
import { pendingUpdateCacheDir } from "./updater-cache"
import { updaterDialogLabels } from "./updater-dialog-labels"
import { createMainWindow, setDockIcon } from "./windows"

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

let dshUrl: string | undefined
let fileInputPreload: string | undefined
// DSH states the cause and the fix on its own stderr before it exits, and a
// failure that early has no window to render it in. Keeping the tail costs a few
// kilobytes and is the only copy the dialog can reach.
const DSH_OUTPUT_TAIL_CHARS = 4_000
let dshOutputTail = ""
let sidecar: DshSidecar | undefined
let sidecarShutdown: Promise<void> | undefined
let sidecarStopRequested = false
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
    if (BrowserWindow.getAllWindows().length === 0 && dshUrl) openMainWindow()
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

  void app
    .whenReady()
    .then(async () => {
      app.setAsDefaultProtocolClient("pawwork")
      setDockIcon()
      setupAutoUpdater()
      await startDsh()
      openMainWindow()
      wireMenu()
    })
    .catch(async (error) => {
      logger.error("app initialization failed", error)
      await shutdownSidecar().catch((shutdownError) => logger.error("DSH shutdown failed", shutdownError))
      // The log already holds all of this, but no window ever opened, so the log
      // is the one place the user cannot be expected to look. The dialog is also
      // what keeps the process alive long enough for DSH's last words to reach
      // the log. Failing to show it must not replace the original failure.
      if (!CI_SMOKE_ENABLED) {
        await reportStartupFailure({
          locale: menuLocale,
          logPath: logger.transports.file.getFile().path,
          output: dshOutputTail,
          showMessageBox: (options) => dialog.showMessageBox(options),
          openIssue: () => shell.openExternal(PAWWORK_GITHUB_ISSUE_URL),
          showItemInFolder: async (path) => {
            shell.showItemInFolder(path)
            // Windows hands the reveal to a background task and app.exit skips
            // cleanup, so give the call a moment to land before the process goes.
            await delay(500)
          },
        }).catch((dialogError) => logger.error("startup failure dialog failed", dialogError))
      }
      app.exit(1)
    })
}

async function startDsh() {
  const appPath = app.isPackaged ? app.getAppPath() : join(dirname(fileURLToPath(import.meta.url)), "../..")
  const resources = resolveProductResources({
    appPath,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  // Runs before the overlay is prepared: prepareDshProductHome would create and
  // populate the dotdir home, and the migration would then read it as a home a
  // newer build had already written and leave the real data behind in userData.
  const migration = migrateDshHome({
    home: resolveDshHome({ channel: appChannel, homeRoot: resolvePawWorkHomeRoot() }),
    legacyHome: join(app.getPath("userData"), "dsh"),
    onEvent: (message, detail) => logger.log(message, detail),
  })
  const product = prepareDshProductHome({
    productHome: migration.home,
    resources: resources.dsh,
  })
  fileInputPreload = product.fileInputPreload
  const require = createRequire(import.meta.url)
  const dshPackage = resolveDshPackagePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    resolveDevelopmentPackage: () => require.resolve("@deepseek-ai/dsh/package.json"),
  })

  logger.log("spawning DSH sidecar")
  sidecar = await launchDshSidecar({
    executable: process.execPath,
    dshBin: join(dirname(dshPackage), "lib", "bin.js"),
    sidecarPreload: pathToFileURL(product.sidecarPreload).href,
    productHome: product.home,
    productPatch: product.patch,
    toolsDir: join(dirname(resources.dsh), "tools"),
    env: buildDshEnvironment(resources.skills),
    timeoutMs: 30_000,
    spawn: (executable, args, options) => spawn(executable, args, options),
    onStdout: (chunk) => logger.log("DSH stdout", { chunk: chunk.trimEnd() }),
    onStderr: (chunk) => {
      dshOutputTail = (dshOutputTail + chunk).slice(-DSH_OUTPUT_TAIL_CHARS)
      logger.error("DSH stderr", chunk.trimEnd())
    },
  })
  dshUrl = sidecar.url
  void sidecar.exited.then((code) => {
    logger.error("DSH sidecar exited", { code })
    if (!sidecarStopRequested) app.quit()
  })
}

function openMainWindow() {
  if (!dshUrl || !fileInputPreload) throw new Error("Cannot open PawWork before DSH is ready")
  const win = createMainWindow(dshUrl, fileInputPreload)
  if (currentProgress !== null) win.setProgressBar(currentProgress)
  if (CI_SMOKE_ENABLED) {
    win.webContents.once("did-finish-load", () => {
      mkdirSync(dirname(CI_SMOKE_READY_FILE), { recursive: true })
      writeFileSync(CI_SMOKE_READY_FILE, JSON.stringify({ readyAt: new Date().toISOString() }), "utf8")
    })
  }
  return win
}

function focusMainWindow(openIfMissing = false) {
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  const win = existing ?? (openIfMissing && dshUrl ? openMainWindow() : undefined)
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

async function shutdownSidecar() {
  sidecarShutdown ??= (async () => {
    const active = sidecar
    sidecar = undefined
    if (active) {
      sidecarStopRequested = true
      await active.stop()
    }
  })()
  await sidecarShutdown
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
