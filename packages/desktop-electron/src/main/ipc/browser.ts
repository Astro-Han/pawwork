import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron"
import type { BrowserViewLayout } from "@opencode-ai/app/desktop-api"
import { browserControllers } from "../browser/controller-automation"
import { BROWSER_PARTITION } from "../browser/options"

/**
 * Wires the embedded-browser IPC. Controllers live in the shared main-process
 * registry (controller-automation), keyed by window id and created lazily, so
 * these renderer handlers and the agent automation resolver drive the same
 * WebContentsView per window. Channels mirror the BrowserBridge in the app's
 * platform contract. No automation endpoint/secret is ever exposed over a
 * browser:* channel — that stays main-internal.
 */
export function registerBrowserIpc() {
  const windowFor = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)

  const existing = (event: IpcMainInvokeEvent) => {
    const win = windowFor(event)
    return win ? browserControllers.get(win.id) : undefined
  }

  // Create on first real use (navigate, or a visible set-view) so windows that
  // never open the browser pay nothing.
  const ensure = (event: IpcMainInvokeEvent) => {
    const win = windowFor(event)
    return win ? browserControllers.ensure(win) : undefined
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
    for (const controller of browserControllers.all()) controller.reloadIfLoaded()
  })
  ipcMain.handle("browser:get-state", (event) => existing(event)?.state() ?? null)
}
