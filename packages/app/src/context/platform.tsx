import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type {
  RendererDiagnosticInput,
  RendererDiagnosticsExportResult,
  ReportProblemInput,
  PrepareReportResult,
  SubmitReportResult,
  UpdateInfo,
} from "@/desktop-api-contract"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }

export type {
  RendererDiagnosticInput,
  RendererDiagnosticsExportResult,
  RendererErrorDetails,
  ReportProblemInput,
  PrepareReportResult,
  SubmitReportResult,
  DiagnosticsReviewContents,
  UpdateInfo,
} from "@/desktop-api-contract"

/** A viewport rect in CSS pixels (the renderer's coordinate space). */
export type BrowserViewRect = { x: number; y: number; width: number; height: number }

/** Desired presentation of the embedded browser overlay, sent as one unit so
 *  visibility and bounds never race. `rect` is ignored when `visible` is false.
 *  `claim` marks a push that may (re)take the display — sent while the panel
 *  has newly become visible, swapped targets, or left the displaced state, and
 *  re-sent until main confirms it applied. Geometry-only ticks leave it unset,
 *  so an in-flight resize from a window that just lost the display can never
 *  steal it back. */
export type BrowserViewLayout = { visible: boolean; rect: BrowserViewRect; claim?: boolean }

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

/** Which conversation's browser a call addresses: its root session id, or the
 *  literal "draft" for this window's not-yet-created conversation (the
 *  new-session page). Drafts are window-private; main resolves them. */
export type BrowserTarget = string

/**
 * Control surface for the embedded browser (one app-owned WebContentsView per
 * conversation, all sharing a persistent partition). Every call names its
 * target conversation; main validates the target against what the calling
 * window is showing. Desktop/Electron only — undefined on web, where there is
 * no native view to drive. Gate usage with `canUseBrowser`.
 */
export type BrowserBridge = {
  navigate(target: BrowserTarget, url: string): Promise<void>
  goBack(target: BrowserTarget): Promise<void>
  goForward(target: BrowserTarget): Promise<void>
  reload(target: BrowserTarget): Promise<void>
  stop(target: BrowserTarget): Promise<void>
  /** Report desired visibility + bounds (CSS px). The main process converts to
   *  device-independent pixels using the window's zoom factor. Resolves true
   *  when a visible push actually displayed the view in this window — a claim
   *  keeps being re-sent until that confirmation arrives (the first one can be
   *  dropped while the window's DesktopContext still lags a route change). */
  setView(target: BrowserTarget, layout: BrowserViewLayout): Promise<boolean>
  /** Hand this window's draft view to the session just created from it. Must
   *  resolve BEFORE navigating to the session route, so the new panel finds
   *  the adopted view instead of lazily creating an empty one. */
  adoptDraft(sessionID: string): Promise<{ adopted: boolean; hasPage: boolean }>
  /** Destroy the target's page outright (view, history, renderer process) via
   *  the same chain as session delete/archive. WYSIWYG counterpart of the
   *  browser tab's ×. Cookies/storage survive in the shared partition. */
  closePage(target: BrowserTarget): Promise<void>
  /** Sign out of every site: clear cookies, storage, and cache (all targets —
   *  the partition is shared). */
  clearData(): Promise<void>
  /** Read a target's current state once (used to seed a freshly mounted panel). */
  getState(target: BrowserTarget): Promise<BrowserState | null>
  /** Subscribe to state pushes; filter by target. Returns an unsubscribe function. */
  onState(cb: (payload: { target: BrowserTarget; state: BrowserState }) => void): () => void
  /** Another window started displaying a conversation's view; the panel that
   *  lost it shows a placeholder and stops reporting layout. */
  onDisplayTaken(cb: (payload: { target: BrowserTarget }) => void): () => void
  /** Subscribe to "the agent attached browser automation" pushes — the UI
   *  surfaces the driven conversation's browser tab. Returns an unsubscribe
   *  function. */
  onAutomationAttached(cb: (payload: { sessionID: string }) => void): () => void
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

  /** Recover the local path behind a desktop browser File object, when Electron exposes one. */
  filePathForBrowserFile?(file: File): Promise<string | null>

  /** Persist pathless pasted or dragged content to app-managed local storage and return its path. */
  saveAttachmentFile?(file: File): Promise<string | null>

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

  /**
   * Generate, redact, and save a diagnostics package, returning its contents for
   * review. No side effects beyond writing the file — the user then reveals it
   * (`revealReport`) or opens the feedback form (`submitReport`). Desktop only.
   */
  prepareReport?(input?: ReportProblemInput): Promise<PrepareReportResult>

  /** Reveal the prepared package in the OS file manager (desktop only). */
  revealReport?(reportId: string): Promise<void>

  /** Open the configured feedback form after review (desktop only). */
  submitReport?(reportId: string): Promise<SubmitReportResult>

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
