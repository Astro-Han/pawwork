import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
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
import { ensureVerifiedCommunityMarket } from "./dsh-market-guard"
import { createDshMenu } from "./dsh-menu"
import { assertDshPluginRequest, requestDshCommunityMarket } from "./dsh-plugins"
import {
  buildDshEnvironment,
  prepareDshProductHome,
  resolveHostModules,
  resolveDshPackagePath,
  resolvePnpmPackagePath,
  resolveProductResources,
} from "./dsh-product-home"
import { deferDshRun, launchDshSidecar } from "./dsh-sidecar"
import { prepareDshToolsEnvironment } from "./dsh-tools"
import { removeProfileBundle, unresolvedProfileBundle } from "./dsh-profile-repair"
import { migrateDshHome, resolveDshHome } from "./pawwork-home"
import { initLogging } from "./logging"
import { detectSystemMenuLocale, type MenuLocale } from "./menu-labels"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"
import { PAWWORK_GITHUB_ISSUE_URL } from "./support-links"
import { createUpdaterController } from "./updater"
import { createUpdateScheduler } from "./updater-scheduler"
import { pendingUpdateCacheDir } from "./updater-cache"
import { readStartupColorScheme, writeStartupColorScheme } from "./startup-theme"
import {
  createMainWindow,
  navigateWindow,
  setDockIcon,
  setTitlebarColorScheme,
  startupUrl,
  type StartupColorScheme,
} from "./windows"

contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

if (process.platform === "darwin") {
  try {
    process.chdir(homedir())
  } catch {}
}

const CI_SMOKE_HOME = process.env.PAWWORK_CI_SMOKE_HOME
const CI_SMOKE_ENABLED = process.env.PAWWORK_CI_SMOKE === "true"
const UPDATE_FEED_TIMEOUT_MS = 10_000
// Silent re-check cadence while the app runs: frequent enough that users who
// never quit pick up a release the same day, sparse enough to stay noise-free.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_CHANNEL_FILE = process.platform === "win32" ? `${UPDATE_CHANNEL}.yml` : `${UPDATE_CHANNEL}-mac.yml`
const LATEST_RELEASE_URL = `https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`
// Shown while the community market is upgraded ahead of DSH. DSH prints nothing
// until it is ready, so an unnamed wait in front of it reads as a frozen app.
const MARKET_UPGRADE_NOTICE: Record<MenuLocale, string> = {
  en: "Updating the community plugin market…",
  zh: "正在更新社区插件市场…",
}

const userDataRoot = CI_SMOKE_HOME ?? app.getPath("appData")
const appChannel = app.isPackaged ? CHANNEL : "dev"
const appIdentity = PAWWORK_APP[appChannel]
app.setName(appIdentity.name)
if (CI_SMOKE_HOME) app.setPath("appData", CI_SMOKE_HOME)
app.setPath("userData", join(userDataRoot, appIdentity.id))
if (CI_SMOKE_HOME) app.setPath("logs", join(app.getPath("userData"), "logs"))

const CI_SMOKE_READY_FILE = join(app.getPath("userData"), "ci-smoke-ready.json")
const STARTUP_THEME_FILE = join(app.getPath("userData"), "startup-theme.json")
const { autoUpdater } = pkg
const logger = initLogging()
// Both the value and the reading of it have to wait for `ready`: before it,
// getLocale() answers "" and getSystemLocale() throws. getLocale() is also the
// wrong question — it reports the locale Electron's own UI was built for, which
// is en-US on a zh-CN machine. Everything that reads this runs after ready.
let menuLocale: MenuLocale = "en"

// Pure path work over values that never change for the life of the process, so
// there is nothing to sequence and nothing that can be read before it is set.
const productPaths = {
  appPath: app.isPackaged ? app.getAppPath() : join(dirname(fileURLToPath(import.meta.url)), "../.."),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
}
const productResources = resolveProductResources(productPaths)
const productPreload = join(productResources.dsh, "product", "preload.cjs")

// DSH states the cause and the fix on its own stderr before it exits, and the
// window has no other copy of it: once DSH is gone, its stdio is gone with it.
// Keeping the tail costs a few kilobytes.
const DSH_OUTPUT_TAIL_CHARS = 4_000
let dshOutputTail = ""
// Set by launchDsh: the recovery path needs the profile directory, and the home
// is only settled once the migration inside launchDsh has run.
let dshHome: string | undefined
let startupColorScheme: StartupColorScheme | undefined = readStartupColorScheme(STARTUP_THEME_FILE)
let currentProgress: number | null = null
const dshHostToken = randomUUID()

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

const updateScheduler = createUpdateScheduler({
  check: () => updater.check(),
  intervalMs: UPDATE_CHECK_INTERVAL_MS,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

// The single push channel the renderer's update UI lives on: every controller
// transition and every download-progress tick is mirrored to all windows.
type UpdaterSnapshot = {
  state: ReturnType<typeof updater.getState>
  progress: number | null
  currentVersion: string
}

function updaterSnapshot(): UpdaterSnapshot {
  return { state: updater.getState(), progress: currentProgress, currentVersion: app.getVersion() }
}

function publishUpdaterState() {
  for (const win of liveWindows()) win.webContents.send("pawwork:updater:state", updaterSnapshot())
}

updater.subscribe(publishUpdaterState)

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
  ipcMain.handle("pawwork:dsh-community-market:status", (event) => requestDshCommunityMarket({
    action: "status",
    dshUrl: communityMarketUrlFor(event),
    hostToken: dshHostToken,
  }))
  ipcMain.handle("pawwork:dsh-community-market:enable", async (event) => {
    // Anything running in the product frame can reach this channel, plugins
    // included, and the frame check cannot tell them apart from the settings
    // page. The confirmation is native so the decision to hand third-party code
    // PawWork's permissions is always the user's, made outside the page.
    const dshUrl = communityMarketUrlFor(event)
    if (!(await confirmCommunityMarket(event, "enable"))) {
      return requestDshCommunityMarket({ action: "status", dshUrl, hostToken: dshHostToken })
    }
    return requestDshCommunityMarket({ action: "enable", dshUrl, hostToken: dshHostToken })
  })
  ipcMain.handle("pawwork:dsh-community-market:disable", async (event) => {
    const dshUrl = communityMarketUrlFor(event)
    if (!(await confirmCommunityMarket(event, "disable"))) {
      return requestDshCommunityMarket({ action: "status", dshUrl, hostToken: dshHostToken })
    }
    return requestDshCommunityMarket({ action: "disable", dshUrl, hostToken: dshHostToken })
  })
  ipcMain.handle("pawwork:updater:get-state", (event) => {
    readyProductStateFor(event)
    return updaterSnapshot()
  })
  ipcMain.handle("pawwork:updater:check", (event) => {
    readyProductStateFor(event)
    return updater.check()
  })
  ipcMain.handle("pawwork:updater:install", (event) => {
    readyProductStateFor(event)
    return updater.install()
  })
  ipcMain.on("pawwork:updater:open-download-page", (event) => {
    try {
      readyProductStateFor(event)
    } catch (error) {
      logger.warn("rejected updater download page request", error)
      return
    }
    void shell.openExternal(LATEST_RELEASE_URL)
  })
  ipcMain.on("pawwork:dsh-restart", (event) => {
    try {
      communityMarketUrlFor(event)
    } catch (error) {
      logger.warn("rejected DSH restart request", error)
      return
    }
    showStartupPage()
    void lifecycle.stop()
      .then(() => lifecycle.start())
      .catch((error) => logger.error("DSH restart failed", error))
  })
  ipcMain.on("pawwork:product-ready", (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    lifecycle.productReady(event.senderFrame?.url ?? "")
    // The product UI is up: run the first silent check and start the cadence.
    // start() is idempotent, so re-readies after a DSH restart are harmless.
    if (UPDATER_ACTIVE) updateScheduler.start()
  })
  ipcMain.on("pawwork:titlebar-color-scheme", (event, colorScheme) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner) setTitlebarColorScheme(owner, process.platform, colorScheme)
    if (colorScheme !== "dark" && colorScheme !== "light") return
    if (colorScheme === startupColorScheme) return
    startupColorScheme = colorScheme
    writeStartupColorScheme(STARTUP_THEME_FILE, colorScheme)
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
    updateScheduler.stop()
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
      menuLocale = detectSystemMenuLocale(app.getSystemLocale())
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

async function confirmCommunityMarket(event: Electron.IpcMainInvokeEvent, action: "disable" | "enable") {
  const copy = menuLocale === "zh"
    ? {
        enable: {
          message: "启用 DSH 社区插件市场？",
          detail: "市场及其中的插件由第三方维护，安装后会以爪印的权限运行。你可以随时在设置里停用市场。",
          confirm: "启用",
        },
        disable: {
          message: "停用 DSH 社区插件市场？",
          detail: "市场会从爪印的 DSH 环境中移除，已安装的社区插件将不再加载。设置里可以重新启用。",
          confirm: "停用",
        },
        cancel: "取消",
      }
    : {
        enable: {
          message: "Enable the DSH community plugin market?",
          detail: "The market and its plugins are maintained by third parties and run with PawWork's permissions."
            + " You can turn the market off again from Settings at any time.",
          confirm: "Enable",
        },
        disable: {
          message: "Disable the DSH community plugin market?",
          detail: "The market is removed from PawWork's DSH environment and installed community plugins stop loading."
            + " You can enable it again from Settings.",
          confirm: "Disable",
        },
        cancel: "Cancel",
      }
  const prompt = copy[action]
  const owner = BrowserWindow.fromWebContents(event.sender)
  const options = {
    type: "question" as const,
    message: prompt.message,
    detail: prompt.detail,
    buttons: [prompt.confirm, copy.cancel],
    defaultId: 0,
    cancelId: 1,
  }
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

function readyProductStateFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  const state = lifecycle.state
  const frame = event.senderFrame
  if (state.phase !== "ready") throw new Error("DSH plugin requests require a ready product")
  assertDshPluginRequest({
    dshUrl: state.url,
    isMainFrame: frame === event.sender.mainFrame,
    senderUrl: frame?.url ?? "",
  })
  return state
}

function communityMarketUrlFor(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return readyProductStateFor(event).url
}

function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
}

function dshUrl() {
  return lifecycle.url
}

function showStartupPage(notice?: string) {
  for (const win of liveWindows()) navigateWindow(win, startupUrl(startupColorScheme, notice))
}

async function showDshFailure(state: Extract<DshLifecycleState, { phase: "failed" }>) {
  const copy = menuLocale === "zh"
    ? {
        title: state.reason === "startup" ? "爪印无法启动" : "爪印已停止",
        message: state.reason === "startup" ? "智能体运行时未能启动。" : "智能体运行时意外退出。",
        pluginCause: (bundle: string) =>
          `插件「${bundle}」没有安装完整，运行时因此起不来。移除它就能重新打开爪印，之后可以在设置里重新安装。`,
        removePlugin: "移除该插件并重试",
        removeFailed: (bundle: string) => `没能移除插件「${bundle}」，请查看日志。`,
        retry: "重试",
        showLog: "显示日志",
        report: "反馈问题",
        quit: "退出",
        log: "完整日志",
      }
    : {
        title: state.reason === "startup" ? "PawWork Could Not Start" : "PawWork Stopped",
        message: state.reason === "startup" ? "The agent runtime did not start." : "The agent runtime stopped unexpectedly.",
        pluginCause: (bundle: string) =>
          `The plugin "${bundle}" is not fully installed, which stops the runtime from starting.`
          + " Removing it lets PawWork open again; you can reinstall it from Settings afterwards.",
        removePlugin: "Remove Plugin and Retry",
        removeFailed: (bundle: string) => `Could not remove the plugin "${bundle}". See the log for details.`,
        retry: "Try Again",
        showLog: "Show Log",
        report: "Report a Problem",
        quit: "Quit",
        log: "Full log",
      }
  const logPath = logger.transports.file.getFile().path
  const error = state.error instanceof Error ? state.error.message : String(state.error ?? "")
  // The runtime's own stderr is a Node stack over DSH's internals; it belongs in
  // the log, not in front of someone who just wants their app back. Only the one
  // fact they can act on is lifted out of it.
  const bundle = dshHome === undefined ? undefined : unresolvedProfileBundle(`${error}\n${dshOutputTail}`)
  let note = ""

  for (;;) {
    const buttons = [
      ...(bundle === undefined ? [] : [copy.removePlugin]),
      copy.retry,
      copy.showLog,
      copy.report,
      copy.quit,
    ]
    const options = {
      type: "error" as const,
      title: copy.title,
      message: copy.message,
      // The runtime output only earns its space when nothing else explains the
      // failure: once the bundle is named, the tail is the same stack the
      // sentence already summarizes.
      detail: [
        note,
        ...(bundle === undefined ? [error, dshOutputTail.trim()] : [copy.pluginCause(bundle)]),
        `${copy.log}: ${logPath}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    }
    const owner = BrowserWindow.getFocusedWindow() ?? liveWindows()[0]
    const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    const chosen = buttons[result.response]

    if (chosen === copy.removePlugin && bundle !== undefined && dshHome !== undefined) {
      let removed: boolean
      try {
        removed = removeProfileBundle({ profileDir: join(dshHome, "profiles", "web"), bundle })
      } catch (failure) {
        logger.error("failed to remove unresolved profile bundle", failure)
        note = copy.removeFailed(bundle)
        continue
      }
      // Nothing removed means the row was never in this manifest — the bundle
      // comes from somewhere we do not own, so restarting would hit the same
      // failure. Say so rather than reporting a repair that did not happen.
      if (!removed) {
        logger.error("unresolved profile bundle was not declared in the profile", { bundle })
        note = copy.removeFailed(bundle)
        continue
      }
      logger.log("removed unresolved profile bundle", { bundle })
      focusMainWindow(true)
      lifecycle.start()
      return
    }
    if (chosen === copy.retry) {
      focusMainWindow(true)
      lifecycle.start()
      return
    }
    if (chosen === copy.showLog) {
      shell.showItemInFolder(logPath)
      continue
    }
    if (chosen === copy.report) {
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
    hostModules: resolveHostModules(productPaths),
  })
  dshHome = product.home
  const require = createRequire(import.meta.url)
  const dshPackage = resolveDshPackagePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    resolveDevelopmentPackage: () => require.resolve("@deepseek-ai/dsh/package.json"),
  })
  const pnpmPackage = resolvePnpmPackagePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    resolveDevelopmentPackage: () => require.resolve("pnpm"),
  })
  const dshBin = join(dirname(dshPackage), "lib", "bin.js")
  const environment = prepareDshToolsEnvironment({
    dshBin,
    env: buildDshEnvironment(productResources.skills),
    executable: process.execPath,
    home: product.home,
    hostToken: dshHostToken,
    pnpmBin: join(dirname(pnpmPackage), "bin", "pnpm.mjs"),
    productToolsDir: join(dirname(productResources.dsh), "tools"),
  })

  return deferDshRun((signal) => ensureVerifiedCommunityMarket({
    dshBin,
    env: environment,
    executable: process.execPath,
    profileDir: join(product.home, "profiles", "web"),
    spawn: (executable, args, options) => spawn(executable, args, options),
    signal,
    onUpgradeStart: () => showStartupPage(MARKET_UPGRADE_NOTICE[menuLocale]),
    log: (message, detail) => logger.log(message, detail),
  }), () => {
    logger.log("spawning DSH sidecar")
    return launchDshSidecar({
      executable: process.execPath,
      dshBin,
      sidecarPreload: pathToFileURL(product.sidecarPreload).href,
      productPatch: product.patch,
      env: environment,
      spawn: (executable, args, options) => spawn(executable, args, options),
      onStdout: (chunk) => logger.log("DSH stdout", { chunk: chunk.trimEnd() }),
      onStderr: (chunk) => {
        dshOutputTail = (dshOutputTail + chunk).slice(-DSH_OUTPUT_TAIL_CHARS)
        logger.error("DSH stderr", chunk.trimEnd())
      },
      onError: (error) => logger.error("DSH sidecar process error", error),
    })
  })
}

function openMainWindow() {
  const win = createMainWindow({
    preload: productPreload,
    dshUrl,
    startupColorScheme,
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
    checkForUpdates: () => void updater.check(),
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
  publishUpdaterState()
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
    publishUpdaterState()
  })
  autoUpdater.on("update-downloaded", clearProgressBar)
  autoUpdater.on("update-not-available", clearProgressBar)
  autoUpdater.on("update-cancelled", clearProgressBar)
  autoUpdater.on("error", (error) => {
    logger.error("updater error", error)
    clearProgressBar()
  })
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
