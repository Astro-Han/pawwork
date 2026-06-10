import { BrowserWindow } from "electron"
import { browserControllers } from "./controller-automation"
import { createBrowserBridgeHost, type BrowserBridgeHost } from "./automation-resolver"

/**
 * Electron wiring for the automation resolver: live BrowserWindow list +
 * renderer-reported DesktopContext (sessionID per window) + the shared
 * controller registry. Kept separate from automation-resolver.ts so the
 * selection logic stays importable under bun test.
 */
export function createDesktopBrowserBridgeHost(deps: {
  sessionIDForWindow: (windowID: number) => string | null
}): BrowserBridgeHost {
  return createBrowserBridgeHost({
    windows: () =>
      BrowserWindow.getAllWindows()
        .filter((win) => !win.isDestroyed())
        .map((win) => ({ windowID: win.id, sessionID: deps.sessionIDForWindow(win.id) })),
    focusedWindowID: () => BrowserWindow.getFocusedWindow()?.id ?? null,
    attachWindow: (windowID) => {
      const win = BrowserWindow.fromId(windowID)
      if (!win || win.isDestroyed())
        throw Object.assign(new Error("The selected window closed before the browser could attach."), {
          code: "no-window",
        })
      return browserControllers.attachForWindow(win)
    },
    detachWindow: (windowID) => browserControllers.detachForWindow(windowID),
  })
}
