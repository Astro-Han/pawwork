import { contextBridge, ipcRenderer, webUtils } from "electron"
import { buildDesktopContext } from "@opencode-ai/app/desktop-api"
import type { BrowserState } from "@opencode-ai/app/desktop-api"
import type { DesktopContext, ElectronAPI, InitStep, SqliteMigrationProgress } from "./types"
import { getRuntimeFlags } from "./runtime-flags"

const runtimeFlags = getRuntimeFlags(process.env)
const invokeSetDesktopContext = (context: DesktopContext) => ipcRenderer.invoke("set-desktop-context", context)

const browser: ElectronAPI["browser"] = {
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
  goBack: () => ipcRenderer.invoke("browser:back"),
  goForward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  stop: () => ipcRenderer.invoke("browser:stop"),
  setView: (layout) => ipcRenderer.invoke("browser:set-view", layout),
  clearData: () => ipcRenderer.invoke("browser:clear-data"),
  getState: () => ipcRenderer.invoke("browser:get-state"),
  onState: (cb) => {
    const handler = (_: unknown, state: BrowserState) => cb(state)
    ipcRenderer.on("browser:state", handler)
    return () => ipcRenderer.removeListener("browser:state", handler)
  },
  onAutomationAttached: (cb) => {
    const handler = () => cb()
    ipcRenderer.on("browser:automation-attached", handler)
    return () => ipcRenderer.removeListener("browser:automation-attached", handler)
  },
}

const api: ElectronAPI = {
  ciSmokeEnabled: runtimeFlags.ciSmokeEnabled,
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: (onStep) => {
    const handler = (_: unknown, step: InitStep) => onStep(step)
    ipcRenderer.on("init-step", handler)
    return ipcRenderer.invoke("await-initialization").finally(() => {
      ipcRenderer.removeListener("init-step", handler)
    })
  },
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  getWslConfig: () => ipcRenderer.invoke("get-wsl-config"),
  setWslConfig: (config) => ipcRenderer.invoke("set-wsl-config", config),
  getWindowConfig: () => ipcRenderer.invoke("get-window-config"),
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  parseMarkdownCommand: (markdown) => ipcRenderer.invoke("parse-markdown", markdown),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  wslPath: (path, mode) => ipcRenderer.invoke("wsl-path", path, mode),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  reportCiSmokeReady: () => ipcRenderer.invoke("report-ci-smoke-ready"),
  reportDeepLinkReady: () => ipcRenderer.invoke("report-deep-link-ready"),

  getWindowCount: () => ipcRenderer.invoke("get-window-count"),
  onSqliteMigrationProgress: (cb) => {
    const handler = (_: unknown, progress: SqliteMigrationProgress) => cb(progress)
    ipcRenderer.on("sqlite-migration-progress", handler)
    return () => ipcRenderer.removeListener("sqlite-migration-progress", handler)
  },
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readFileDataUrl: (path, mime) => ipcRenderer.invoke("read-file-data-url", path, mime),
  filePathForBrowserFile: (file) => webUtils.getPathForFile(file),
  saveAttachmentFile: (name, mime, buffer) => ipcRenderer.invoke("save-attachment-file", name, mime, buffer),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  exportSession: (sessionID, directory, defaultName, title) =>
    ipcRenderer.invoke("export-session", sessionID, directory, defaultName, title),
  openLink: (url) => ipcRenderer.send("open-link", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  showItemInFolder: (path) => ipcRenderer.invoke("show-item-in-folder", path),
  statPaths: (paths) => ipcRenderer.invoke("stat-paths", paths),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  showNotification: (title, body) => ipcRenderer.send("show-notification", title, body),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  setDesktopContext: (context) => invokeSetDesktopContext(context),
  initializeDesktopContext: (locale) =>
    invokeSetDesktopContext(buildDesktopContext({ route: "/", locale })),
  loadingWindowComplete: () => ipcRenderer.send("loading-window-complete"),
  runUpdater: (alertOnFail) => ipcRenderer.invoke("run-updater", alertOnFail),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  reportProblem: (input) => ipcRenderer.invoke("report-problem", input),
  emitRendererDiagnostic: (event) => ipcRenderer.invoke("renderer-diagnostics:record", event),
  exportDiagnosticsLog: () => ipcRenderer.invoke("renderer-diagnostics:export"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  setLspEnabled: (value: boolean) => ipcRenderer.invoke("lsp-set-enabled", value),
  setWebSearchEnabled: (value: boolean) => ipcRenderer.invoke("websearch-set-enabled", value),
  webSearchStatus: () => ipcRenderer.invoke("websearch-status"),
  saveExaApiKey: (key: string) => ipcRenderer.invoke("websearch-save-exa-key", key),
  removeExaApiKey: () => ipcRenderer.invoke("websearch-remove-exa-key"),
  getAboutInfo: () => ipcRenderer.invoke("about:get-info"),
  onAboutOpen: (handler: () => void) => {
    const wrapped = () => handler()
    ipcRenderer.on("about:open", wrapped)
    return () => {
      ipcRenderer.removeListener("about:open", wrapped)
    }
  },
  flashFrame: () => ipcRenderer.invoke("flash-frame"),
  setBadgeCount: (count: number) => ipcRenderer.invoke("set-badge-count", count),
  browser,
}

contextBridge.exposeInMainWorld("api", api)
