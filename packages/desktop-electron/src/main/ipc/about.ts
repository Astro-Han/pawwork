import { app, BrowserWindow, ipcMain } from "electron"

export type AboutInfo = {
  version: string
  electronVersion: string
  chromeVersion: string
  buildSha: string
}

function readBuildSha(): string {
  const sha = import.meta.env.PAWWORK_BUILD_SHA
  return sha && sha.length > 0 ? sha : "unknown"
}

export function registerAboutIpc() {
  ipcMain.handle("about:get-info", (): AboutInfo => ({
    version: app.getVersion(),
    electronVersion: process.versions.electron ?? "unknown",
    chromeVersion: process.versions.chrome ?? "unknown",
    buildSha: readBuildSha(),
  }))
}

function isAppShellWindow(win: BrowserWindow): boolean {
  // Loading window loads `loading.html`; the About bridge is only mounted in the main app renderer.
  return !win.webContents.getURL().endsWith("loading.html")
}

export function triggerAbout(browserWindow?: BrowserWindow) {
  const candidate = browserWindow && isAppShellWindow(browserWindow) ? browserWindow : undefined
  const target = candidate ?? BrowserWindow.getAllWindows().find(isAppShellWindow)
  target?.webContents.send("about:open")
}
