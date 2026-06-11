import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from "electron"
import type { BrowserViewLayout } from "@opencode-ai/app/desktop-api"
import { browserControllers } from "../browser/controller-automation"
import { draftKey } from "../browser/registry"
import { BROWSER_PARTITION } from "../browser/options"

/**
 * Wires the embedded-browser IPC. Controllers live in the shared main-process
 * registry (controller-automation), keyed by conversation (root session) or
 * per-window Home draft and created lazily. Every channel carries the
 * renderer's target; main validates it against what the calling window
 * actually shows (its renderer-reported DesktopContext), so a stale or
 * miswired panel can never read or steer another conversation's view — the
 * call no-ops instead. No automation endpoint/secret is ever exposed over a
 * browser:* channel — that stays main-internal.
 */
export function registerBrowserIpc(deps: { sessionIDForWindow: (windowID: number) => string | null }) {
  // Never trust the renderer's target: "draft" means the calling window's own
  // draft and only while that window is on Home (no session shown), and a
  // session target must be the session that window currently shows. Anything
  // else resolves to null and the channel does nothing.
  const resolve = (event: IpcMainInvokeEvent, target: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    if (target === "draft") return deps.sessionIDForWindow(win.id) === null ? { win, key: draftKey(win.id) } : null
    if (typeof target === "string" && target.length > 0 && target === deps.sessionIDForWindow(win.id))
      return { win, key: target }
    return null
  }

  const existing = (event: IpcMainInvokeEvent, target: unknown) => {
    const resolved = resolve(event, target)
    return resolved ? browserControllers.get(resolved.key) : undefined
  }

  // Create on first real use (navigate, or a visible set-view) so conversations
  // that never open the browser pay nothing.
  const ensure = (event: IpcMainInvokeEvent, target: unknown) => {
    const resolved = resolve(event, target)
    return resolved ? browserControllers.ensure(resolved.key) : undefined
  }

  ipcMain.handle("browser:navigate", (event, target: string, url: string) => ensure(event, target)?.navigate(url))
  ipcMain.handle("browser:back", (event, target: string) => existing(event, target)?.goBack())
  ipcMain.handle("browser:forward", (event, target: string) => existing(event, target)?.goForward())
  ipcMain.handle("browser:reload", (event, target: string) => existing(event, target)?.reload())
  ipcMain.handle("browser:stop", (event, target: string) => existing(event, target)?.stop())
  ipcMain.handle("browser:set-view", (event, target: string, layout: BrowserViewLayout) => {
    const resolved = resolve(event, target)
    if (!resolved) return
    // Only spin up a view when there is something to show; hiding a view that
    // was never created is a no-op.
    if (layout.visible) browserControllers.ensure(resolved.key).display(resolved.win, layout.rect)
    else browserControllers.get(resolved.key)?.hideFor(resolved.win)
  })
  // Draft adoption can't name-check the session against DesktopContext: it runs
  // by design BEFORE the renderer navigates to the just-created session's
  // route. But that same ordering means the window must still be on Home, so
  // gate on that; the window can only ever hand over its own draft, and the
  // registry fails soft if the target session somehow already has a view.
  ipcMain.handle("browser:adopt-draft", (event, sessionID: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || typeof sessionID !== "string" || !sessionID || deps.sessionIDForWindow(win.id) !== null)
      return { adopted: false, hasPage: false }
    return browserControllers.adoptDraft(win.id, sessionID)
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
  ipcMain.handle("browser:get-state", (event, target: string) => existing(event, target)?.state() ?? null)
}
