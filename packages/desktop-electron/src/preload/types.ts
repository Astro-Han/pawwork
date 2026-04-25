import type { DesktopContext, ReportProblemInput, ReportProblemResult, UpdateInfo } from "@opencode-ai/app/desktop-api"

export type { DesktopContext }
export type { ReportProblemInput, ReportProblemResult, UpdateInfo }

export type InitStep = { phase: "server_waiting" } | { phase: "sqlite_waiting" } | { phase: "done" }

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type SqliteMigrationProgress = { type: "InProgress"; value: number } | { type: "Done" }

export type WslConfig = { enabled: boolean }

export type WindowConfig = {
  updaterEnabled: boolean
  wslEnabled: boolean
}

export type LinuxDisplayBackend = "wayland" | "auto"

export type AboutInfo = {
  version: string
  electronVersion: string
  chromeVersion: string
  buildSha: string
}

export type ElectronAPI = {
  ciSmokeEnabled: boolean
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: (onStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void>
  getWindowConfig: () => Promise<WindowConfig>
  consumeInitialDeepLinks: () => Promise<string[]>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  reportCiSmokeReady: () => Promise<void>
  reportDeepLinkReady: () => Promise<void>

  getWindowCount: () => Promise<number>
  onSqliteMigrationProgress: (cb: (progress: SqliteMigrationProgress) => void) => () => void
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    accept?: string[]
    extensions?: string[]
  }) => Promise<string | string[] | null>
  readFileDataUrl: (path: string, mime: string) => Promise<string | null>
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  exportSession: (
    sessionID: string,
    directory: string,
    defaultName?: string,
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  showItemInFolder: (path: string) => Promise<void>
  statPaths: (paths: string[]) => Promise<Record<string, { size: number; exists: boolean }>>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => void
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  setDesktopContext: (context: DesktopContext) => Promise<void>
  initializeDesktopContext: (locale: DesktopContext["locale"]) => Promise<void>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void>
  checkUpdate: () => Promise<UpdateInfo>
  reportProblem: (input?: ReportProblemInput) => Promise<ReportProblemResult>
  installUpdate: () => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  getAboutInfo: () => Promise<AboutInfo>
  onAboutOpen: (handler: () => void) => () => void
}
