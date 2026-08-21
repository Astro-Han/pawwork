import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
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
import { DshLifecycle, type DshLifecycleState } from "./dsh-lifecycle"
import { createDshMenu } from "./dsh-menu"
import {
  buildDshEnvironment,
  prepareDshProductHome,
  resolveDshPackagePath,
  resolveProductResources,
} from "./dsh-product-home"
import { launchDshSidecar } from "./dsh-sidecar"
import { migrateDshHome, resolveDshHome } from "./pawwork-home"
import { initLogging } from "./logging"
import { detectSystemMenuLocale } from "./menu-labels"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"
import { PAWWORK_GITHUB_ISSUE_URL } from "./support-links"
import { createUpdaterController } from "./updater"
import { pendingUpdateCacheDir } from "./updater-cache"
import { updaterDialogLabels } from "./updater-dialog-labels"
import { createMainWindow, navigateWindow, setDockIcon, STARTUP_URL } from "./windows"

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
const productPreload = join(productResources.dsh, "product", "preload.cjs")

// DSH states the cause and the fix on its own stderr before it exits, and the
// window has no other copy of it: once DSH is gone, its stdio is gone with it.
// Keeping the tail costs a few kilobytes.
const DSH_OUTPUT_TAIL_CHARS = 4_000
let dshOutputTail = ""
let currentProgress: number | null = null

const lifecycle = new DshLifecycle({ launch: launchDsh, onChange: handleLifecycleChange })

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
    void lifecycle.stop().finally(() => autoUpdater.quitAndInstall())
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
    const state = lifecycle.state
    if (state.phase !== "ready") throw new Error("Cannot pick files before DSH is ready")
    const owner = BrowserWindow.fromWebContents(event.sender)
    return pickConversationFiles(state.url, event.senderFrame?.url ?? "", (options) =>
      owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
    )
  })
  ipcMain.on("pawwork:product-ready", (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    lifecycle.productReady(event.senderFrame?.url ?? "")
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
    if (lifecycle.state.phase === "stopped") return
    event.preventDefault()
    void lifecycle.stop()
      .catch((error) => logger.error("DSH shutdown failed", error))
      .finally(() => app.quit())
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit())

  void app
    .whenReady()
    .then(() => {
      app.setAsDefaultProtocolClient("pawwork")
      setDockIcon()
      setupAutoUpdater()

      // The window is what makes every DSH failure reportable, so it opens
      // before anything that can fail. The menu goes up with it: it is where the
      // issue link lives, and it used to be built only after a successful start.
      openMainWindow()
      wireMenu()
      lifecycle.start()
    })
    .catch((error) => {
      // Nothing here waits on DSH any more; what is left is Electron's own setup,
      // and a failure in it leaves no window to report through.
      logger.error("app initialization failed", error)
      app.exit(1)
    })
}

function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
}

function dshUrl() {
  return lifecycle.url
}

function showStartupPage() {
  for (const win of liveWindows()) navigateWindow(win, STARTUP_URL)
}

async function showDshFailure(state: Extract<DshLifecycleState, { phase: "failed" }>) {
  const copy = menuLocale === "zh"
    ? {
        title: state.reason === "startup" ? "爪印无法启动" : "爪印已停止",
        message: state.reason === "startup" ? "智能体运行时未能启动。" : "智能体运行时意外退出。",
        buttons: ["重试", "显示日志", "反馈问题", "退出"],
        log: "完整日志",
      }
    : {
        title: state.reason === "startup" ? "PawWork Could Not Start" : "PawWork Stopped",
        message: state.reason === "startup" ? "The agent runtime did not start." : "The agent runtime stopped unexpectedly.",
        buttons: ["Try Again", "Show Log", "Report a Problem", "Quit"],
        log: "Full log",
      }
  const logPath = logger.transports.file.getFile().path
  const error = state.error instanceof Error ? state.error.message : String(state.error ?? "")
  const detail = [error, dshOutputTail.trim(), `${copy.log}: ${logPath}`].filter(Boolean).join("\n\n")

  for (;;) {
    const options = {
      type: "error" as const,
      title: copy.title,
      message: copy.message,
      detail,
      buttons: copy.buttons,
      defaultId: 0,
      cancelId: 3,
    }
    const owner = BrowserWindow.getFocusedWindow() ?? liveWindows()[0]
    const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (result.response === 0) {
      showStartupPage()
      lifecycle.start()
      return
    }
    if (result.response === 1) {
      shell.showItemInFolder(logPath)
      continue
    }
    if (result.response === 2) {
      await shell.openExternal(PAWWORK_GITHUB_ISSUE_URL).catch((failure) => logger.error("failed to open issue form", failure))
      continue
    }
    app.quit()
    return
  }
}

function handleLifecycleChange(state: DshLifecycleState) {
  if (state.phase === "starting") {
    dshOutputTail = ""
    return
  }
  if (state.phase === "loading") {
    for (const win of liveWindows()) navigateWindow(win, state.url)
    return
  }
  if (state.phase === "ready") {
    dshOutputTail = ""
    if (CI_SMOKE_ENABLED) {
      mkdirSync(dirname(CI_SMOKE_READY_FILE), { recursive: true })
      writeFileSync(CI_SMOKE_READY_FILE, JSON.stringify({ readyAt: new Date().toISOString() }), "utf8")
    }
    return
  }
  if (state.phase === "failed") {
    logger.error("DSH lifecycle failed", state.error)
    if (CI_SMOKE_ENABLED) app.exit(1)
    else {
      showStartupPage()
      void showDshFailure(state)
    }
  }
}

function launchDsh() {
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
  return launchDshSidecar({
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
}

function openMainWindow() {
  const win = createMainWindow({
    preload: productPreload,
    dshUrl,
  })
  if (currentProgress !== null) win.setProgressBar(currentProgress)
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
      void lifecycle.stop().finally(() => {
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
