import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron"
import type { BrowserViewLayout } from "@opencode-ai/app/desktop-api"
import { BrowserViewController } from "../browser/controller"
import { BROWSER_PARTITION } from "../browser/options"

/**
 * One controller per window, keyed by window id. Module-scoped (not closed over
 * registerBrowserIpc) so both the renderer IPC handlers and the agent automation
 * bridge resolve the same controllers — the agent drives the window the user sees.
 */
const controllers = new Map<number, BrowserViewController>()

/** No window to attach the embedded browser to — surfaced to the agent verbatim. */
export class NoBrowserWindowError extends Error {
  constructor() {
    super("No PawWork window is open to drive the embedded browser.")
    this.name = "NoBrowserWindowError"
  }
}

// Create on first real use (navigate, a visible set-view, or an agent action) so
// windows that never open the browser pay nothing; torn down with the window.
function ensureControllerForWindow(win: BrowserWindow): BrowserViewController {
  let controller = controllers.get(win.id)
  if (!controller) {
    controller = new BrowserViewController(win)
    controllers.set(win.id, controller)
    win.once("closed", () => {
      controllers.get(win.id)?.destroy()
      controllers.delete(win.id)
    })
  }
  return controller
}

/**
 * Pick the window the agent's browser tools should drive: the focused window, or
 * the only window when exactly one is open. Anything ambiguous (no window, or
 * several with none focused) is a typed error the tool surfaces rather than
 * guessing which window the user meant.
 */
export function resolveAutomationController(): BrowserViewController {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return ensureControllerForWindow(focused)
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  if (windows.length === 1) return ensureControllerForWindow(windows[0]!)
  throw new NoBrowserWindowError()
}

/**
 * Wires the embedded-browser IPC. Channels mirror the BrowserBridge in the app's
 * platform contract. Controllers are shared with the agent automation bridge via
 * the module-scoped map above.
 */
export function registerBrowserIpc() {
  const windowFor = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)

  const existing = (event: IpcMainInvokeEvent) => {
    const win = windowFor(event)
    return win ? controllers.get(win.id) : undefined
  }

  const ensure = (event: IpcMainInvokeEvent) => {
    const win = windowFor(event)
    return win ? ensureControllerForWindow(win) : undefined
  }

  ipcMain.handle("browser:navigate", (event, url: string) => ensure(event)?.navigate(url))
  ipcMain.handle("browser:back", (event) => existing(event)?.goBack())
  ipcMain.handle("browser:forward", (event) => existing(event)?.goForward())
  ipcMain.handle("browser:reload", (event) => existing(event)?.reload())
  ipcMain.handle("browser:stop", (event) => existing(event)?.stop())
  ipcMain.handle("browser:set-view", (event, layout: BrowserViewLayout) => {
    // Only spin up a view when there is something to show; hiding a view that
    // was never created is a no-op.
    const controller = layout.visible ? ensure(event) : existing(event)
    controller?.setView(layout)
  })
  // Browsing data lives in the shared persistent partition, not in any one view,
  // so clear the session directly — this works even before a view exists (e.g.
  // opening the tab fresh after restart). Then reload any live views so they
  // reflect the signed-out state immediately.
  ipcMain.handle("browser:clear-data", async () => {
    const partition = session.fromPartition(BROWSER_PARTITION)
    await partition.clearStorageData()
    await partition.clearCache()
    for (const controller of controllers.values()) controller.reloadIfLoaded()
  })
  ipcMain.handle("browser:get-state", (event) => existing(event)?.state() ?? null)
}
