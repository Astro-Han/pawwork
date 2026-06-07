import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type UpdateFailureReason = "check" | "download" | "metadata" | "cache"
export type UpdateInfo =
  | { updateAvailable: false; status: "disabled" | "none" | "busy"; version?: undefined }
  | { updateAvailable: true; status: "ready"; version: string }
  | { updateAvailable: false; status: "failed"; reason: UpdateFailureReason; message: string; version?: undefined }

export type RendererErrorDetails = {
  summary: string
  details: string
}

export type ReportProblemInput = {
  confirm?: boolean
  rendererError?: RendererErrorDetails
}

export type ReportProblemResult =
  | {
      status: "ready"
      summaryCopied: true
      feedbackOpened: true
      fullReport: { status: "ready"; fileName: string; locationHint: string }
    }
  | {
      status: "summary-only"
      summaryCopied: true
      feedbackOpened: true
      fullReport: { status: "failed" }
    }
  | {
      status: "form-fallback"
      summaryCopied: true
      feedbackOpened: false
      feedbackUrl: string
      fullReport:
        | { status: "ready"; fileName: string; locationHint: string }
        | { status: "failed" }
    }
  | { status: "cancelled"; summaryCopied: false; feedbackOpened: false; fullReport: { status: "none" } }
  | { status: "unavailable"; summaryCopied: false; feedbackOpened: false; fullReport: { status: "none" } }
  | { status: "failed"; summaryCopied: false; feedbackOpened: false; fullReport: { status: "failed" } }

export type RendererDiagnosticInput = {
  name: string
  level?: "info" | "warn"
  monotonic_ms?: number
  trace_id?: string
  route_session_id?: string
  visible_session_id?: string
  timeline_session_id?: string
  message_id?: string
  part_id?: string
  data?: Record<string, unknown>
}

export type RendererDiagnosticsExportResult = { ok: true; path: string } | { ok: false; error: string }

/** A viewport rect in CSS pixels (the renderer's coordinate space). */
export type BrowserViewRect = { x: number; y: number; width: number; height: number }

/** Desired presentation of the embedded browser overlay, sent as one unit so
 *  visibility and bounds never race. `rect` is ignored when `visible` is false. */
export type BrowserViewLayout = { visible: boolean; rect: BrowserViewRect }

/** Snapshot of the embedded browser pushed from the main process on every
 *  navigation/loading change. `hasPage` is false before any successful load,
 *  which keeps the DOM empty state showing and the native view hidden. */
export type BrowserState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  favicon: string | null
  secure: boolean
  hasPage: boolean
}

/**
 * Control surface for the embedded browser (a single app-owned WebContentsView
 * with a persistent partition). Desktop/Electron only — undefined on web, where
 * there is no native view to drive. Gate usage with `canUseBrowser`.
 */
export type BrowserBridge = {
  navigate(url: string): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  reload(): Promise<void>
  stop(): Promise<void>
  /** Report desired visibility + bounds (CSS px). The main process converts to
   *  device-independent pixels using the window's zoom factor. */
  setView(layout: BrowserViewLayout): Promise<void>
  /** Sign out of every site: clear cookies, storage, and cache. */
  clearData(): Promise<void>
  /** Read the current state once (used to seed a freshly mounted panel). */
  getState(): Promise<BrowserState | null>
  /** Subscribe to state pushes; returns an unsubscribe function. */
  onState(cb: (state: BrowserState) => void): () => void
}

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Visual shell contract. Runtime identity stays separate from appearance. */
  shell?: PlatformShell

  /** Runtime desktop OS, Electron only. Visual shell OS lives in shell.os and may be set by Web/E2E. */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Reveal a local path in the system file browser (desktop only) */
  showItemInFolder?(path: string): Promise<void>

  /** Return file existence and size for local paths (desktop only) */
  statPaths?(paths: string[]): Promise<Record<string, { size: number; exists: boolean }>>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /**
   * Request user attention without stealing focus: bounce the Dock (macOS) or
   * flash the taskbar (Windows). Reserved for events that block the agent on
   * the user — a question or permission request — not passive turn-complete or
   * error notices. Desktop only; no-op on web.
   */
  requestAttention?(): Promise<void>

  /** Set the Dock/taskbar unread badge count; 0 hides it (desktop only) */
  setBadgeCount?(count: number): Promise<void>

  /** Open directory picker dialog (native on desktop, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (desktop only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Read a local file as a data URL. Undefined on web, callers must keep a path fallback. */
  readFileDataUrl?(path: string, mime: string): Promise<string | null>

  /** Save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /**
   * Export a session to a local JSON file (desktop only).
   * Main process fetches the internal export route, opens save dialog, writes file.
   */
  exportSession?(
    sessionID: string,
    directory: string,
    defaultName?: string,
    title?: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for updates (desktop only) */
  checkUpdate?(): Promise<UpdateInfo>

  /** Prepare a problem report and open the configured feedback form (desktop only) */
  reportProblem?(input?: ReportProblemInput): Promise<ReportProblemResult>

  /** Emit a local renderer diagnostics event. Desktop only; no-op on web. */
  emitRendererDiagnostic?(event: RendererDiagnosticInput): Promise<void>

  /** Export the current local renderer diagnostics log. Desktop only. */
  exportDiagnosticsLog?(): Promise<RendererDiagnosticsExportResult>

  /** Install updates (desktop only) */
  update?(): Promise<void>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Embedded browser control surface (desktop only). Gate with `canUseBrowser`. */
  browser?: BrowserBridge
}

export type DisplayBackend = "auto" | "wayland"

export type PlatformShell = {
  kind: "desktop" | "web"
  os?: "macos" | "windows" | "linux"
}

export function getShellKind(platform: Pick<Platform, "platform" | "shell">) {
  return platform.shell?.kind ?? (platform.platform === "desktop" ? "desktop" : "web")
}

export function getShellOs(platform: Pick<Platform, "shell" | "os">) {
  return platform.shell?.os ?? platform.os
}

export function shellAttrs(platform: Pick<Platform, "platform" | "shell" | "os">) {
  return {
    "data-shell": getShellKind(platform),
    "data-shell-os": getShellOs(platform),
  }
}

export function isDesktopShell(platform: Pick<Platform, "platform" | "shell">) {
  return getShellKind(platform) === "desktop"
}

export function isMacShell(platform: Pick<Platform, "platform" | "shell" | "os">) {
  return isDesktopShell(platform) && getShellOs(platform) === "macos"
}

export function isWindowsShell(platform: Pick<Platform, "platform" | "shell" | "os">) {
  return isDesktopShell(platform) && getShellOs(platform) === "windows"
}

export function canOpenLocalPath(platform: Pick<Platform, "openPath">) {
  return !!platform.openPath
}

export function canCheckUpdate(platform: Pick<Platform, "checkUpdate">) {
  return !!platform.checkUpdate
}

export function canUseDisplayBackend(platform: Pick<Platform, "getDisplayBackend" | "setDisplayBackend">) {
  return !!platform.getDisplayBackend && !!platform.setDisplayBackend
}

export function canUseNativeFilePicker(platform: Pick<Platform, "openFilePickerDialog">) {
  return !!platform.openFilePickerDialog
}

export function canUseBrowser(platform: Pick<Platform, "browser">) {
  return !!platform.browser
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
