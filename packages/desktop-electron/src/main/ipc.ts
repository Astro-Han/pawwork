import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

import type {
  DesktopContext,
  InitStep,
  ReportProblemInput,
  ReportProblemResult,
  ServerReadyData,
  SqliteMigrationProgress,
  UpdateInfo,
  WindowConfig,
  WslConfig,
} from "../preload/types"
import { attachmentPathMime } from "./attachment-mime"
import { getStore } from "./store"
import { fetchExport } from "./server-client"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

// Keep direct media reads bounded so the privileged main process never base64-loads very large files.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
// Picker approvals are short-lived because they authorize a renderer to request file bytes from main.
const ATTACHMENT_APPROVAL_TTL_MS = 30 * 60 * 1000
const MAX_APPROVED_ATTACHMENT_PATHS = 1000

function normalizeAttachmentPath(filepath: unknown) {
  if (typeof filepath !== "string" || filepath.length === 0) return
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(filepath)) return filepath
  return path.resolve(filepath)
}

type Deps = {
  killSidecar: () => void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getServerReadyData: () => Promise<ServerReadyData>
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  getWslConfig: () => Promise<WslConfig>
  setWslConfig: (config: WslConfig) => Promise<void> | void
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  wslPath: (path: string, mode: "windows" | "linux" | null) => Promise<string>
  resolveAppPath: (appName: string) => Promise<string | null>
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<UpdateInfo>
  reportProblem: (input?: ReportProblemInput) => Promise<ReportProblemResult>
  installUpdate: () => Promise<boolean> | boolean
  setBackgroundColor: (color: string) => void
  reportDeepLinkReady: (win: BrowserWindow | null) => void
  reportCiSmokeReady: () => Promise<void> | void
  setDesktopContext: (context: DesktopContext, win: BrowserWindow) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const approvedAttachmentPaths = new Map<string, number>()
  const approvedAttachmentSenderIds = new Set<number>()

  const attachmentApprovalKey = (senderID: number, filepath: string) => `${senderID}:${filepath}`

  const pruneApprovedAttachmentSender = (senderID: number) => {
    const prefix = `${senderID}:`
    for (const key of approvedAttachmentPaths.keys()) {
      if (key.startsWith(prefix)) approvedAttachmentPaths.delete(key)
    }
    approvedAttachmentSenderIds.delete(senderID)
  }

  const pruneApprovedAttachmentPaths = (now = Date.now()) => {
    for (const [key, approvedAt] of approvedAttachmentPaths) {
      if (now - approvedAt > ATTACHMENT_APPROVAL_TTL_MS) approvedAttachmentPaths.delete(key)
    }
    while (approvedAttachmentPaths.size > MAX_APPROVED_ATTACHMENT_PATHS) {
      // Map iteration order is insertion order, so this removes the oldest approval first.
      const oldest = approvedAttachmentPaths.keys().next().value
      if (!oldest) break
      approvedAttachmentPaths.delete(oldest)
    }
  }

  const trackAttachmentSender = (sender: IpcMainInvokeEvent["sender"]) => {
    if (approvedAttachmentSenderIds.has(sender.id)) return
    approvedAttachmentSenderIds.add(sender.id)
    sender.once("destroyed", () => pruneApprovedAttachmentSender(sender.id))
  }

  const approveAttachmentPaths = (sender: IpcMainInvokeEvent["sender"], paths: string | string[] | null) => {
    const now = Date.now()
    trackAttachmentSender(sender)
    pruneApprovedAttachmentPaths(now)
    for (const filepath of Array.isArray(paths) ? paths : paths ? [paths] : []) {
      const normalized = normalizeAttachmentPath(filepath)
      if (normalized) {
        const key = attachmentApprovalKey(sender.id, normalized)
        approvedAttachmentPaths.delete(key)
        approvedAttachmentPaths.set(key, now)
      }
    }
    pruneApprovedAttachmentPaths(now)
  }

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig())
  ipcMain.handle("set-wsl-config", (_event: IpcMainInvokeEvent, config: WslConfig) => deps.setWslConfig(config))
  ipcMain.handle("get-window-config", () => deps.getWindowConfig())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("wsl-path", (_event: IpcMainInvokeEvent, path: string, mode: "windows" | "linux" | null) =>
    deps.wslPath(path, mode),
  )
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("report-problem", (_event: IpcMainInvokeEvent, input?: ReportProblemInput) =>
    deps.reportProblem(input),
  )
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("report-deep-link-ready", (event: IpcMainInvokeEvent) =>
    deps.reportDeepLinkReady(BrowserWindow.fromWebContents(event.sender)),
  )
  ipcMain.handle("set-desktop-context", (event: IpcMainInvokeEvent, context: DesktopContext) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    return deps.setDesktopContext(context, win)
  })
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    const store = getStore(name)
    const value = store.get(key)
    if (value === undefined || value === null) return null
    return typeof value === "string" ? value : JSON.stringify(value)
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  ipcMain.handle("report-ci-smoke-ready", () => deps.reportCiSmokeReady())

  ipcMain.handle("lsp-set-enabled", async (_event: IpcMainInvokeEvent, value: boolean) => {
    const { Settings, LSP, ToolRegistry, Instance } = await import("virtual:opencode-server")
    await Settings.setLspEnabled(value)
    // LSP.invalidate / ToolRegistry.invalidate / LSP.shutdownAll all read
    // InstanceState.directory, which requires an Instance scope. Process every
    // active instance with isolation so a single failure does not leave the
    // remaining projects stuck on stale cache state.
    const directories = Instance.directories()
    const results = await Promise.allSettled(
      directories.map((directory) =>
        Instance.provide({
          directory,
          fn: async () => {
            if (!value) {
              await LSP.shutdownAll()
            }
            await LSP.invalidate()
            await ToolRegistry.invalidate()
          },
        }),
      ),
    )
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        console.warn("lsp-set-enabled failed for instance", {
          directory: directories[index],
          error: result.reason,
        })
      }
    }
  })

  ipcMain.handle("websearch-set-enabled", async (_event: IpcMainInvokeEvent, value: boolean) => {
    const { Settings, ToolRegistry, Instance } = await import("virtual:opencode-server")
    const previous = await Settings.webSearchEnabled()
    await Settings.setWebSearchEnabled(value)
    const invalidateWebSearchTools = (targetDirectories: string[]) =>
      Promise.allSettled(
        targetDirectories.map((directory) =>
          Instance.provide({
            directory,
            fn: () => ToolRegistry.invalidate(),
          }),
        ),
      )
    const directories = Instance.directories()
    const results = await invalidateWebSearchTools(directories)
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        console.warn("websearch-set-enabled failed for instance", {
          directory: directories[index],
          error: result.reason,
        })
      }
    }
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length > 0) {
      await Settings.setWebSearchEnabled(previous)
      const rollbackDirectories = Instance.directories()
      const rollbackResults = await invalidateWebSearchTools(rollbackDirectories)
      for (const [index, result] of rollbackResults.entries()) {
        if (result.status === "rejected") {
          console.warn("websearch-set-enabled rollback failed for instance", {
            directory: rollbackDirectories[index],
            error: result.reason,
          })
        }
      }
      throw new Error(`Failed to refresh Web Search tools in ${failures.length} project instance(s)`)
    }
  })

  ipcMain.handle("websearch-status", async () => {
    const { WebSearchAuth } = await import("virtual:opencode-server")
    return WebSearchAuth.status()
  })

  ipcMain.handle("websearch-save-exa-key", async (_event: IpcMainInvokeEvent, key: string) => {
    const { WebSearchAuth } = await import("virtual:opencode-server")
    return WebSearchAuth.saveKey(key)
  })

  ipcMain.handle("websearch-remove-exa-key", async () => {
    const { WebSearchAuth } = await import("virtual:opencode-server")
    return WebSearchAuth.removeKey()
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const paths = opts?.multiple ? result.filePaths : (result.filePaths[0] ?? null)
      approveAttachmentPaths(event.sender, paths)
      return paths
    },
  )

  ipcMain.handle("read-file-data-url", async (event: IpcMainInvokeEvent, filepath: string, mime: string) => {
    let normalized: string | undefined
    try {
      normalized = normalizeAttachmentPath(filepath)
      pruneApprovedAttachmentPaths()
      if (!normalized || !approvedAttachmentPaths.has(attachmentApprovalKey(event.sender.id, normalized))) return null
      if (attachmentPathMime(normalized) !== mime) return null
      const stat = await fs.stat(normalized)
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) return null
      const buffer = await fs.readFile(normalized)
      return `data:${mime};base64,${buffer.toString("base64")}`
    } catch (err) {
      console.warn("read-file-data-url failed", normalized ?? filepath, err)
      return null
    }
  })

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.handle(
    "export-session",
    async (_event: IpcMainInvokeEvent, sessionID: string, directory: string, defaultName?: string) => {
      if (typeof sessionID !== "string" || typeof directory !== "string") {
        return { ok: false, error: "invalid_args" } as const
      }
      const server = await deps.getServerReadyData()
      const fetched = await fetchExport(server, directory, sessionID)
      if (!fetched.ok) return fetched

      const fallbackStamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "")
      const result = await dialog.showSaveDialog({
        title: "Export session log",
        defaultPath: defaultName ?? `pawwork-session-${sessionID.slice(-8)}-${fallbackStamp}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      if (result.canceled || !result.filePath) return { ok: false, error: "cancelled" } as const

      try {
        await fs.writeFile(result.filePath, fetched.body, "utf8")
        return { ok: true, path: result.filePath } as const
      } catch (err) {
        return { ok: false, error: (err as Error).message } as const
      }
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("show-item-in-folder", (_event: IpcMainInvokeEvent, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle("stat-paths", async (_event: IpcMainInvokeEvent, paths: string[]) => {
    const entries = await Promise.all(
      paths.map(async (file) => {
        try {
          const stat = await fs.stat(file)
          return [file, { size: stat.size, exists: true }] as const
        } catch {
          return [file, { size: 0, exists: false }] as const
        }
      }),
    )
    return Object.fromEntries(entries)
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  const flashFrameTimers = new Map<number, ReturnType<typeof setTimeout>>()

  ipcMain.handle("flash-frame", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    if (process.platform === "darwin") {
      // macOS: bounce the Dock icon once
      app.dock?.bounce()
    } else {
      // Windows/Linux: flash the taskbar button
      // Clear any existing timer for this window
      const existing = flashFrameTimers.get(win.id)
      if (existing !== undefined) clearTimeout(existing)

      win.flashFrame(true)
      flashFrameTimers.set(
        win.id,
        setTimeout(() => {
          flashFrameTimers.delete(win.id)
          if (!win.isDestroyed()) win.flashFrame(false)
        }, 1000),
      )
    }
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => event.sender.setZoomFactor(factor))
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
