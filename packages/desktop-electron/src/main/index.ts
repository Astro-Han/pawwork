import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  Notification,
  shell,
  type Event,
} from "electron"
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
import { failingProfileBundle, removeProfileBundle } from "./dsh-profile-repair"
import { migrateDshHome, resolveDshHome } from "./pawwork-home"
import { initLogging } from "./logging"
import { launchFileFromArgs, launchFolderFromArgs, validWorkspaceDirectory } from "./launch-workspace"
import { quitWhenAllWindowsClosed, sidebarMode } from "./launch-mode"
import { canonicalWorkspaceDirectory, hasApprovedWorkspace, lastApprovedWorkspace, rememberWorkspace } from "./workspace-access"
import { foregroundExplorerDirectory } from "./active-explorer"
import { detectSystemMenuLocale, type MenuLocale } from "./menu-labels"
import { createUpdateFeed, githubFeed, r2Feed, type FeedTarget } from "./update-feed"
import { applyUserShellPath } from "./user-shell-env"
import { PAWWORK_GITHUB_ISSUE_URL } from "./support-links"
import { createUpdaterController } from "./updater"
import { createUpdateScheduler } from "./updater-scheduler"
import { pendingUpdateCacheDir } from "./updater-cache"
import { readStartupColorScheme, writeStartupColorScheme } from "./startup-theme"
import type { WindowColorScheme } from "./window-options"
import { applyWindowColorScheme, createMainWindow, navigateWindow, setDockIcon, startupUrl } from "./windows"
import { fileNotePath, readWorkspaceNotes, saveWorkspaceNotes } from "./workspace-notes"
import { readPageNote, savePageNote } from "./workspace-notes"
import { documentPrompt, type DocumentAction } from "./document-analysis"
import { isReadableDocument, readDocument, readUploadedDocument } from "./document-reader"
import { changeWorkspaceTask, nextReminderAt, readWorkspaceTasks, saveWorkspaceTask, takeDueReminders, type TaskDraft, type WorkspaceTask } from "./workspace-tasks"

contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

if (process.platform === "darwin") {
  try {
    process.chdir(homedir())
  } catch {}
}

const CI_SMOKE_HOME = process.env.PAWWORK_CI_SMOKE_HOME
const CI_SMOKE_ENABLED = process.env.PAWWORK_CI_SMOKE === "true"
const SIDEBAR_MODE = sidebarMode(process.platform, app.isPackaged, process.env.PAWWORK_SIDEBAR, process.argv)
const startupWorkspace = launchFolderFromArgs(process.argv)
const startupFile = launchFileFromArgs(process.argv)
const explicitWorkspaceLaunch = process.argv.includes("--workspace") || process.argv.includes("--note-file")
let authorizedWorkspace: string | undefined
let appQuitting = false
let workspaceHotkeyPending = false
const UPDATE_FEED_TIMEOUT_MS = 10_000
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const UPDATE_CHANNEL_FILE = process.platform === "win32" ? `${UPDATE_CHANNEL}.yml` : `${UPDATE_CHANNEL}-mac.yml`
const LATEST_RELEASE_URL = `https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`

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
const WORKSPACE_ACCESS_FILE = join(app.getPath("userData"), "workspace-access.json")
const { autoUpdater } = pkg
const logger = initLogging()
let menuLocale: MenuLocale = "en"

const userShellPath = applyUserShellPath()

const productPaths = {
  appPath: app.isPackaged ? app.getAppPath() : join(dirname(fileURLToPath(import.meta.url)), "../.."),
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
}
const productResources = resolveProductResources(productPaths)
const productPreload = join(productResources.dsh, "product", "preload.cjs")
const notesPreload = join(productResources.dsh, "product", "notes-preload.cjs")
const notesPage = join(productResources.dsh, "product", "notes.html")
let notesWindow: BrowserWindow | undefined
let notesWorkspace: string | undefined
let pdfWindow: BrowserWindow | undefined
let pdfSource: string | undefined
let noteSource: string | undefined
let taskReminderTimer: ReturnType<typeof setTimeout> | undefined

const DSH_OUTPUT_TAIL_CHARS = 40_000
const DSH_OUTPUT_EXCERPT_CHARS = 4_000
let dshOutputTail = ""
let dshHome: string | undefined
let publishedColorScheme: WindowColorScheme | undefined = readStartupColorScheme(STARTUP_THEME_FILE)

function windowColorScheme(): WindowColorScheme {
  return publishedColorScheme ?? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
}

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

  ipcMain.handle("window:minimize", (event) => windowFor(event).minimize())
  ipcMain.handle("window:maximize-toggle", (event) => {
    const win = windowFor(event)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle("window:close", (event) => windowFor(event).close())
  ipcMain.handle("pawwork:get-current-directory", (event) => {
    shellWindowFor(event)
    return authorizedWorkspace ?? process.cwd()
  })
  ipcMain.handle("pawwork:get-launch-directory", (event) => {
    shellWindowFor(event)
    return authorizedWorkspace ?? null
  })
  ipcMain.handle("pawwork:set-current-directory", async (event, folder: unknown) => {
    windowFor(event)
    const workspace = canonicalWorkspaceDirectory(folder)
    if (!workspace) throw new Error("Choose an existing folder")
    if (workspace === authorizedWorkspace) return workspace
    const allowed = await requestWorkspaceAccess(workspace)
    if (!allowed) throw new Error("Folder access was canceled")
    return allowed
  })
  ipcMain.handle("pawwork:is-sidebar", (event) => {
    shellWindowFor(event)
    return SIDEBAR_MODE
  })
  ipcMain.handle("pawwork:open-notes", async (event) => {
    windowFor(event)
    if (!authorizedWorkspace) await requestWorkspaceAccess()
    openNotesWindow()
  })
  ipcMain.handle("pawwork:notes:read", (event) => {
    notesSender(event)
    if (!notesWorkspace) throw new Error("Choose a folder first")
    return readWorkspaceNotes(notesWorkspace, noteSource)
  })
  ipcMain.handle("pawwork:notes:choose-file", async (event) => {
    const owner = notesSender(event)
    if (!notesWorkspace) throw new Error("Choose a folder first")
    const choice = await dialog.showOpenDialog(owner, {
      title: "Choose a file in your workspace",
      defaultPath: notesWorkspace,
      properties: ["openFile"],
    })
    if (choice.canceled) return { canceled: true }
    fileNotePath(notesWorkspace, choice.filePaths[0]!)
    noteSource = choice.filePaths[0]
    return { canceled: false, ...readWorkspaceNotes(notesWorkspace, noteSource) }
  })
  ipcMain.handle("pawwork:notes:open-file", (event, source: unknown) => {
    notesSender(event)
    if (!notesWorkspace || typeof source !== "string") throw new Error("Choose a folder first")
    fileNotePath(notesWorkspace, source)
    noteSource = source
    return readWorkspaceNotes(notesWorkspace, noteSource)
  })
  ipcMain.handle("pawwork:notes:save", (event, kind: unknown, content: unknown) => {
    notesSender(event)
    if (!notesWorkspace) throw new Error("Choose a folder first")
    if (kind !== "memory" && kind !== "file") throw new Error("Invalid note type")
    if (typeof content !== "string") throw new Error("Invalid note content")
    return { path: saveWorkspaceNotes(notesWorkspace, kind, content, noteSource) }
  })
  ipcMain.handle("pawwork:tasks:list", (event) => {
    notesSender(event)
    if (!notesWorkspace) throw new Error("Choose a folder first")
    return readWorkspaceTasks(notesWorkspace)
  })
  ipcMain.handle("pawwork:tasks:save", (event, draft: TaskDraft) => {
    notesSender(event)
    if (!notesWorkspace) throw new Error("Choose a folder first")
    const original = draft?.id ? readWorkspaceTasks(notesWorkspace).find((task) => task.id === draft.id) : undefined
    if (draft?.source !== null && draft?.source !== original?.source) {
      const selected = noteSource ? fileNotePath(notesWorkspace, noteSource).source : null
      if (draft?.source !== selected) throw new Error("Choose the associated file in File notes first")
    }
    const tasks = saveWorkspaceTask(notesWorkspace, draft)
    scheduleTaskReminders()
    return tasks
  })
  ipcMain.handle("pawwork:tasks:change", (event, id: unknown, action: unknown, minutes?: unknown) => {
    notesSender(event)
    if (!notesWorkspace || typeof id !== "string" ||
      (action !== "complete" && action !== "reopen" && action !== "snooze" && action !== "delete")) throw new Error("Invalid task action")
    const tasks = changeWorkspaceTask(notesWorkspace, id, action, Number(minutes))
    scheduleTaskReminders()
    return tasks
  })
  ipcMain.handle("pawwork:notes:summarize-pdf", async (event) => {
    notesSender(event)
    if (!notesWorkspace || !noteSource || !noteSource.toLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF in your workspace")
    fileNotePath(notesWorkspace, noteSource)
    if (lifecycle.state.phase !== "ready") throw new Error("The agent is still starting")
    const workspace = notesWorkspace
    const file = noteSource
    const document = await withDocumentReader(() => readDocument(file, documentReaderOptions(event.sender)))
    for (const win of liveWindows()) {
      if (win !== notesWindow) win.webContents.send("pawwork:summarize-pdf", { file, workspace, document })
    }
    focusMainWindow(true)
    return { queued: true }
  })
  ipcMain.handle("pawwork:notes:read-page", (event, page: unknown) => {
    notesSender(event)
    if (!notesWorkspace || !noteSource || !noteSource.toLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF")
    return readPageNote(notesWorkspace, noteSource, Number(page))
  })
  ipcMain.handle("pawwork:notes:save-page", (event, page: unknown, content: unknown) => {
    notesSender(event)
    if (!notesWorkspace || !noteSource || !noteSource.toLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF")
    if (typeof content !== "string") throw new Error("Invalid annotation")
    return { path: savePageNote(notesWorkspace, noteSource, Number(page), content) }
  })
  ipcMain.handle("pawwork:notes:open-pdf", (event, page: unknown) => {
    notesSender(event)
    if (!notesWorkspace || !noteSource || !noteSource.toLowerCase().endsWith(".pdf")) throw new Error("Choose a PDF")
    fileNotePath(notesWorkspace, noteSource)
    const number = Number(page)
    if (!Number.isInteger(number) || number < 1 || number > 100_000) throw new Error("Invalid PDF page")
    openPdfViewer(noteSource, number)
  })
  ipcMain.handle("pawwork:notes:analyze", async (event, action: unknown, page: unknown) => {
    const owner = notesSender(event)
    if (!notesWorkspace || !noteSource) throw new Error("Choose a file")
    if (action !== "ocr" && action !== "drawing" && action !== "compare") throw new Error("Invalid document action")
    fileNotePath(notesWorkspace, noteSource)
    let otherFile: string | undefined
    if (action === "compare") {
      const choice = await dialog.showOpenDialog(owner, { title: "Choose the newer revision", defaultPath: notesWorkspace, properties: ["openFile"] })
      if (choice.canceled) return { canceled: true }
      otherFile = choice.filePaths[0]
      fileNotePath(notesWorkspace, otherFile!)
    }
    const prompt = documentPrompt(action as DocumentAction, noteSource, Number(page), otherFile)
    if (lifecycle.state.phase !== "ready") throw new Error("The agent is still starting")
    for (const win of liveWindows()) win.webContents.send("pawwork:analyze-document", { prompt, workspace: notesWorkspace })
    focusMainWindow(true)
    return { queued: true }
  })
  ipcMain.handle("pawwork:create-workspace-shortcut", (event, folder: unknown) => {
    windowFor(event)
    if (process.platform !== "win32") throw new Error("Folder shortcuts are available on Windows")
    const workspace = validWorkspaceDirectory(folder)
    if (!workspace) throw new Error("Choose an existing folder")
    const desktop = app.getPath("desktop")
    const name = `PawWork - ${basename(workspace)}`
    let shortcut = join(desktop, `${name}.lnk`)
    for (let copy = 2; existsSync(shortcut); copy += 1) shortcut = join(desktop, `${name} (${copy}).lnk`)
    const appArg = app.isPackaged ? "" : `"${app.getAppPath()}" `
    const created = shell.writeShortcutLink(shortcut, "create", {
      target: process.execPath,
      args: `${appArg}--sidebar --workspace "${workspace}"`,
      cwd: workspace,
      description: `Open PawWork in ${workspace}`,
    })
    if (!created) throw new Error("Could not create the desktop shortcut")
    return { path: shortcut }
  })
  ipcMain.handle("pawwork:save-note", async (event, content: unknown, defaultName?: string) => {
    const win = windowFor(event)
    if (typeof content !== "string" || content.length > 10_000_000) throw new Error("Invalid note content")
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: basename(defaultName || "note.txt"),
      filters: [{ name: "Text", extensions: ["txt"] }, { name: "Markdown", extensions: ["md"] }],
    })
    if (canceled || !filePath) return { canceled: true }
    writeFileSync(filePath, content, "utf8")
    return { canceled: false, path: filePath }
  })
  ipcMain.handle("pawwork:save-image", async (event, data: unknown, defaultName?: string) => {
    const win = windowFor(event)
    if (typeof data !== "string") throw new Error("Invalid image data")
    const match = /^(?:data:image\/(?:png|jpeg);base64,)?([A-Za-z0-9+/]+={0,2})$/.exec(data)
    if (!match || match[1]!.length > 28_000_000) throw new Error("Invalid image data")
    const bytes = Buffer.from(match[1]!, "base64")
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: basename(defaultName || "image.png"),
      filters: [{ name: "PNG", extensions: ["png"] }, { name: "JPEG", extensions: ["jpg", "jpeg"] }],
    })
    if (canceled || !filePath) return { canceled: true }
    writeFileSync(filePath, bytes)
    return { canceled: false, path: filePath }
  })
  ipcMain.handle("pawwork:set-reminder", (event, title: unknown, body: unknown, delayMs: unknown) => {
    windowFor(event)
    if (typeof title !== "string" || typeof body !== "string" || !title.trim() || title.length > 200 || body.length > 2000 ||
      typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 2_147_483_647) {
      throw new Error("Invalid reminder")
    }
    if (!Notification.isSupported()) throw new Error("Desktop notifications are unavailable")
    setTimeout(() => {
      try {
        new Notification({ title, body }).show()
      } catch (error) {
        logger.warn("reminder notification failed", error)
      }
    }, delayMs)
    return { scheduled: true }
  })

  const documentReaderOptions = (sender: Electron.WebContents) => ({
    executable: process.execPath,
    script: join(resolveProductResources({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }).dsh, "product", "document-reader.cjs"),
    hostModules: resolveHostModules({ appPath: app.getAppPath(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    onProgress: (message: string) => { if (!sender.isDestroyed()) sender.send("pawwork:document-progress", message) },
  })
  let readingDocument = false
  async function withDocumentReader<T>(read: () => Promise<T>) {
    if (readingDocument) throw new Error("A document is already being read. Please wait for it to finish.")
    readingDocument = true
    try { return await read() } finally { readingDocument = false }
  }
  ipcMain.handle("pawwork:read-uploaded-document", (event, name: string, data: Uint8Array) => {
    readyProductStateFor(event)
    return withDocumentReader(() => readUploadedDocument(name, data, documentReaderOptions(event.sender)))
  })
  ipcMain.handle("pawwork:pick-conversation-files", async (event) => {
    const state = lifecycle.state
    if (state.phase !== "ready") throw new Error("Cannot pick files before DSH is ready")
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await pickConversationFiles(state.url, event.senderFrame?.url ?? "", (options) =>
      owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
    )
    if (result.status === "canceled") return result
    const files = result.paths.filter(isReadableDocument)
    if (files.length === 0) return result
    if (files.length > 5) throw new Error("Read up to five documents at a time")
    return withDocumentReader(async () => {
      const documents = []
      for (const file of files) documents.push(await readDocument(file, documentReaderOptions(event.sender)))
      return { ...result, documents }
    })
  })
  ipcMain.handle("pawwork:pick-workspace-file", async (event) => {
    const owner = windowFor(event)
    const workspace = authorizedWorkspace ?? await requestWorkspaceAccess()
    if (!workspace) return { status: "canceled" as const }
    const result = await dialog.showOpenDialog(owner, {
      title: "Mention a file in your allowed folder",
      defaultPath: workspace,
      properties: ["openFile"],
    })
    if (result.canceled || !result.filePaths[0]) return { status: "canceled" as const }
    fileNotePath(workspace, result.filePaths[0])
    if (isReadableDocument(result.filePaths[0])) {
      const document = await withDocumentReader(() => readDocument(result.filePaths[0], documentReaderOptions(event.sender)))
      return { status: "selected" as const, path: result.filePaths[0], document }
    }
    return { status: "selected" as const, path: result.filePaths[0] }
  })
  ipcMain.handle("pawwork:dsh-community-market:status", (event) =>
    requestDshCommunityMarket({
      action: "status",
      dshUrl: communityMarketUrlFor(event),
      hostToken: dshHostToken,
    })
  )
  ipcMain.handle("pawwork:dsh-community-market:enable", async (event) => {
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
    void lifecycle
      .stop()
      .then(() => lifecycle.start())
      .catch((error) => logger.error("DSH restart failed", error))
  })
  ipcMain.on("pawwork:product-ready", (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    lifecycle.productReady(event.senderFrame?.url ?? "")
    if (UPDATER_ACTIVE) updateScheduler.start()
  })
  ipcMain.on("pawwork:titlebar-color-scheme", (event, colorScheme) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    if (colorScheme !== "dark" && colorScheme !== "light") return
    for (const win of liveWindows()) applyWindowColorScheme(win, process.platform, colorScheme, SIDEBAR_MODE)
    if (colorScheme === publishedColorScheme) return
    publishedColorScheme = colorScheme
    writeStartupColorScheme(STARTUP_THEME_FILE, colorScheme)
  })

  app.on("second-instance", (_event, argv) => {
    focusMainWindow(true)
    const workspace = launchFolderFromArgs(argv)
    if (workspace) void requestWorkspaceAccess(workspace, launchFileFromArgs(argv))
  })
  app.on("open-url", (event: Event) => {
    event.preventDefault()
    focusMainWindow(true)
  })
  app.on("window-all-closed", () => {
    if (quitWhenAllWindowsClosed(process.platform, SIDEBAR_MODE)) app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
  app.on("before-quit", (event) => {
    appQuitting = true
    updateScheduler.stop()
    if (taskReminderTimer) clearTimeout(taskReminderTimer)
    globalShortcut.unregister("Control+Alt+A")
    if (lifecycle.state.phase === "stopped") return
    event.preventDefault()
    void lifecycle
      .stop()
      .catch((error) => logger.error("DSH shutdown failed", error))
      .finally(() => app.quit())
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit())

  void app
    .whenReady()
    .then(async () => {
      menuLocale = detectSystemMenuLocale(app.getSystemLocale())

      if (!CI_SMOKE_ENABLED && !app.requestSingleInstanceLock()) {
        logger.info("second instance: forwarded launch request to running PawWork")
        app.exit(0)
        return
      }

      if (app.isPackaged && !CI_SMOKE_ENABLED) app.setAsDefaultProtocolClient("pawwork")
      if (app.isPackaged && !CI_SMOKE_ENABLED) {
        try {
          app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false, path: process.execPath,
            args: ["--sidebar"] })
        } catch (error) {
          logger.warn("could not enable launch at login", error)
        }
      }
      setDockIcon()
      setupAutoUpdater()

      openMainWindow()
      wireMenu()
      if (!globalShortcut.register("Control+Alt+A", () => {
        logger.info("sidebar shortcut pressed")
        if (workspaceHotkeyPending) { focusMainWindow(true); return }
        workspaceHotkeyPending = true
        void foregroundExplorerDirectory(() => focusMainWindow(true))
          .then(async (folder) => {
            logger.info("sidebar workspace lookup", { found: !!folder })
            if (folder) await requestWorkspaceAccess(folder)
          })
          .catch((error) => logger.warn("could not open workspace from shortcut", error))
          .finally(() => { workspaceHotkeyPending = false })
      })) logger.warn("Ctrl+Alt+A is already in use")
      if (process.platform === "darwin" && !(await userShellPath)) {
        logger.log("could not resolve the user's shell PATH; keeping the inherited PATH")
      }
      lifecycle.start()
      if (startupWorkspace) void requestWorkspaceAccess(startupWorkspace, startupFile)
      else if (!explicitWorkspaceLaunch) {
        authorizedWorkspace = lastApprovedWorkspace(WORKSPACE_ACCESS_FILE)
        if (authorizedWorkspace) scheduleTaskReminders()
      }
    })
    .catch((error) => {
      logger.error("app initialization failed", error)
      app.exit(1)
    })
}

async function confirmCommunityMarket(event: Electron.IpcMainInvokeEvent, action: "disable" | "enable") {
  const copy =
    menuLocale === "zh"
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
            detail:
              "The market and its plugins are maintained by third parties and run with PawWork's permissions." +
              " You can turn the market off again from Settings at any time.",
            confirm: "Enable",
          },
          disable: {
            message: "Disable the DSH community plugin market?",
            detail:
              "The market is removed from PawWork's DSH environment and installed community plugins stop loading." +
              " You can enable it again from Settings.",
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

function windowFor(event: Electron.IpcMainInvokeEvent) {
  const url = lifecycle.url
  if (!url) throw new Error("Product is unavailable")
  assertDshPluginRequest({ dshUrl: url, isMainFrame: event.senderFrame === event.sender.mainFrame, senderUrl: event.senderFrame?.url ?? "" })
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) throw new Error("Window is unavailable")
  return win
}

// The shell asks for these read-only values before the DSH product reports ready.
function shellWindowFor(event: Electron.IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || win === notesWindow || win === pdfWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Shell request came from another window")
  }
  return win
}

function notesSender(event: Electron.IpcMainInvokeEvent) {
  if (!notesWindow || notesWindow.isDestroyed() || event.sender !== notesWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Notes request came from another window")
  }
  return notesWindow
}

function openNotesWindow(source?: string) {
  if (!authorizedWorkspace) return
  if (source) fileNotePath(authorizedWorkspace, source)
  if (notesWindow && !notesWindow.isDestroyed()) {
    if (notesWorkspace !== authorizedWorkspace) {
      const choice = dialog.showMessageBoxSync(notesWindow, {
        type: "question",
        title: "Open notes for another folder",
        message: "Close the current notes window and open notes for the selected folder?",
        detail: "Save any changes in the current notes window first.",
        buttons: ["Keep current notes", "Open selected folder"],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice !== 1) { notesWindow.focus(); return }
      notesWindow.close()
    } else {
      if (source) notesWindow.webContents.send("pawwork:notes:open-file", source)
      notesWindow.show()
      notesWindow.focus()
      return
    }
  }
  notesWorkspace = authorizedWorkspace
  noteSource = source
  const win = new BrowserWindow({
    width: 540,
    height: 680,
    minWidth: 400,
    minHeight: 440,
    alwaysOnTop: true,
    title: "PawWork Notes",
    webPreferences: { preload: notesPreload, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  notesWindow = win
  win.on("closed", () => { if (notesWindow === win) { notesWindow = undefined; notesWorkspace = undefined; noteSource = undefined } })
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  void win.loadFile(notesPage).catch((error) => logger.error("failed to open notes window", error))
}

function showTaskReminder(task: WorkspaceTask) {
  const label = task.source ?? "memory.md"
  try {
    if (Notification.isSupported()) new Notification({
      title: task.title,
      body: `${label} · Due ${new Date(task.dueAt).toLocaleString()}${task.description ? `\n${task.description}` : ""}`,
    }).show()
  } catch (error) {
    logger.warn("task notification failed", error)
  }
  openNotesWindow()
  if (notesWorkspace !== authorizedWorkspace || !notesWindow || notesWindow.isDestroyed()) return
  const win = notesWindow
  const display = () => { if (!win.isDestroyed()) win.webContents.send("pawwork:tasks:reminder", task.id) }
  if (win.webContents.getURL() !== pathToFileURL(notesPage).href || win.webContents.isLoadingMainFrame()) {
    win.webContents.once("did-finish-load", display)
  }
  else display()
  win.show()
  win.focus()
}

function scheduleTaskReminders() {
  if (taskReminderTimer) clearTimeout(taskReminderTimer)
  taskReminderTimer = undefined
  if (!authorizedWorkspace) return
  try {
    const pending = readWorkspaceTasks(authorizedWorkspace).filter((task) => !task.completedAt && !task.notifiedAt)
    if (!pending.length) return
    const next = Math.min(...pending.map(nextReminderAt))
    taskReminderTimer = setTimeout(() => {
      taskReminderTimer = undefined
      if (!authorizedWorkspace) return
      try {
        for (const task of takeDueReminders(authorizedWorkspace)) showTaskReminder(task)
        notesWindow?.webContents.send("pawwork:tasks:changed")
      } catch (error) {
        logger.error("task reminder failed", error)
      }
      scheduleTaskReminders()
    }, Math.min(Math.max(0, next - Date.now()), 2_147_483_647))
  } catch (error) {
    logger.error("task scheduling failed", error)
  }
}

function openPdfViewer(file: string, page: number) {
  const url = `${pathToFileURL(file).href}#page=${page}`
  pdfSource = file
  if (!pdfWindow || pdfWindow.isDestroyed()) {
    const win = new BrowserWindow({
      width: 980,
      height: 800,
      title: `PawWork PDF — ${basename(file)}`,
      webPreferences: { plugins: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    pdfWindow = win
    win.on("closed", () => { if (pdfWindow === win) pdfWindow = undefined })
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    win.webContents.on("will-navigate", (event, target) => {
      if (!pdfSource || target.split("#", 1)[0] !== pathToFileURL(pdfSource).href) event.preventDefault()
    })
  }
  void pdfWindow.loadURL(url).catch((error) => logger.error("failed to open PDF", error))
  pdfWindow.show()
  pdfWindow.focus()
}

async function requestWorkspaceAccess(folder?: string, file?: string): Promise<string | undefined> {
  const owner = liveWindows()[0] ?? openMainWindow()
  let selected = folder
  if (!selected) {
    const result = await dialog.showOpenDialog(owner, { title: "Choose a folder for PawWork", properties: ["openDirectory"] })
    if (result.canceled) return
    selected = result.filePaths[0]
  }
  const workspace = canonicalWorkspaceDirectory(selected)
  if (!workspace) return
  if (workspace !== authorizedWorkspace && !hasApprovedWorkspace(WORKSPACE_ACCESS_FILE, workspace)) {
    const permission = await dialog.showMessageBox(owner, {
      type: "question",
      title: "Folder access",
      message: `Allow PawWork to access this folder?\n${workspace}`,
      detail: "The agent can read and edit files in this folder after you allow access.",
      buttons: ["Allow access", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    })
    if (permission.response !== 0) return
  }
  authorizedWorkspace = workspace
  try { rememberWorkspace(WORKSPACE_ACCESS_FILE, workspace) }
  catch (error) {
    logger.warn("could not remember folder access", error)
    void dialog.showMessageBox(owner, { type: "warning", title: "Folder access", message: "Folder access is available for this session, but PawWork could not remember it for next time." })
  }
  scheduleTaskReminders()
  for (const win of liveWindows()) win.webContents.send("pawwork:open-workspace", workspace)
  if (file) openNotesWindow(file)
  return workspace
}

function liveWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && win !== notesWindow && win !== pdfWindow)
}

function dshUrl() {
  return lifecycle.url
}

function showStartupPage(notice?: string) {
  for (const win of liveWindows()) navigateWindow(win, startupUrl(windowColorScheme(), notice))
}

async function showDshFailure(state: Extract<DshLifecycleState, { phase: "failed" }>) {
  const copy =
    menuLocale === "zh"
      ? {
          title: state.reason === "startup" ? "爪印无法启动" : "爪印已停止",
          message: state.reason === "startup" ? "智能体运行时未能启动。" : "智能体运行时意外退出。",
          pluginCause: {
            missing: (bundle: string) =>
              `插件「${bundle}」没有安装完整，运行时因此起不来。移除它就能重新打开爪印，之后可以在设置里重新安装。`,
            incompatible: (bundle: string) =>
              `插件「${bundle}」与当前版本的爪印不兼容，运行时因此起不来。移除它就能重新打开爪印；等插件发布适配新版本的更新后，再到设置里装回来。`,
          },
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
          pluginCause: {
            missing: (bundle: string) =>
              `The plugin "${bundle}" is not fully installed, which stops the runtime from starting.` +
              " Removing it lets PawWork open again; you can reinstall it from Settings afterwards.",
            incompatible: (bundle: string) =>
              `The plugin "${bundle}" is not compatible with this version of PawWork, which stops the runtime from starting.` +
              " Removing it lets PawWork open again; you can install it again from Settings once the plugin ships an update.",
          },
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
  const failure = dshHome === undefined ? undefined : failingProfileBundle(`${error}\n${dshOutputTail}`)
  let note = ""

  for (;;) {
    const buttons = [
      ...(failure === undefined ? [] : [copy.removePlugin]),
      copy.retry,
      copy.showLog,
      copy.report,
      copy.quit,
    ]
    const options = {
      type: "error" as const,
      title: copy.title,
      message: copy.message,
      detail: [
        note,
        ...(failure === undefined
          ? [error, dshOutputTail.slice(-DSH_OUTPUT_EXCERPT_CHARS).trim()]
          : [copy.pluginCause[failure.cause](failure.bundle)]),
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

    if (chosen === copy.removePlugin && failure !== undefined && dshHome !== undefined) {
      const bundle = failure.bundle
      let removed: boolean
      try {
        removed = removeProfileBundle({ profileDir: join(dshHome, "profiles", "web"), bundle })
      } catch (removeFailure) {
        logger.error("failed to remove failing profile bundle", removeFailure)
        note = copy.removeFailed(bundle)
        continue
      }
      if (!removed) {
        logger.error("failing profile bundle was not declared in the profile", { bundle, cause: failure.cause })
        note = copy.removeFailed(bundle)
        continue
      }
      logger.log("removed failing profile bundle", { bundle, cause: failure.cause })
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
  const product = prepareDshProductHome({
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

  return deferDshRun(
    (signal) =>
      ensureVerifiedCommunityMarket({
        dshBin,
        env: environment,
        executable: process.execPath,
        profileDir: join(product.home, "profiles", "web"),
        spawn: (executable, args, options) => spawn(executable, args, options),
        signal,
        onUpgradeStart: () => showStartupPage(MARKET_UPGRADE_NOTICE[menuLocale]),
        log: (message, detail) => logger.log(message, detail),
      }),
    () => {
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
    }
  )
}

function openMainWindow() {
  const win = createMainWindow({
    preload: productPreload,
    dshUrl,
    colorScheme: windowColorScheme(),
    sidebar: SIDEBAR_MODE,
  })
  if (SIDEBAR_MODE) win.on("close", (event) => {
    if (appQuitting) return
    event.preventDefault()
    win.hide()
  })
  if (currentProgress !== null) win.setProgressBar(currentProgress)
  return win
}

function focusMainWindow(openIfMissing = false) {
  const [existing] = liveWindows()
  const win = existing ?? (openIfMissing ? openMainWindow() : undefined)
  if (win?.isMinimized()) win.restore()
  win?.show()
  win?.focus()
}

function wireMenu() {
  createDshMenu(
    {
      checkForUpdates: () => void updater.check(),
      newWindow: openMainWindow,
      relaunch: () => {
        void lifecycle.stop().finally(() => {
          app.relaunch()
          app.exit(0)
        })
      },
    },
    menuLocale
  )
}

function applyProgressBar(value: number) {
  for (const win of BrowserWindow.getAllWindows()) win.setProgressBar(value)
}

function clearProgressBar() {
  currentProgress = null
  applyProgressBar(-1)
  publishUpdaterState()
}

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
