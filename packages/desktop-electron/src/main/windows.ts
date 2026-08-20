import windowState from "electron-window-state"
import log from "electron-log/main.js"
import { app, BrowserWindow, nativeImage, shell } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { macTrafficLightPosition, pawworkWindowTitle, titlebarInsetCss } from "./window-chrome"
import { decideDshNavigation, guardDshNavigation } from "./window-navigation"
import { dshTitleBarOptions, dshWebPreferences } from "./window-options"

const root = dirname(fileURLToPath(import.meta.url))

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const extension = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${extension}`)
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function createMainWindow(url: string, preload: string) {
  const state = windowState({ defaultWidth: 1280, defaultHeight: 800 })
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 768,
    minHeight: 480,
    show: false,
    title: "PawWork",
    icon: iconPath(),
    ...dshTitleBarOptions(process.platform),
    ...(process.platform === "darwin" ? { trafficLightPosition: macTrafficLightPosition() } : {}),
    webPreferences: dshWebPreferences(preload),
  })

  state.manage(win)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const decision = decideDshNavigation(url, target)
    if (decision === "same-window") void win.loadURL(target)
    if (decision === "external") void openExternal(target)
    return { action: "deny" }
  })
  win.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) {
      guardDshNavigation(url, event.url, event, openExternal)
      return
    }
    if (decideDshNavigation(url, event.url) !== "same-window") event.preventDefault()
  })
  win.webContents.on("will-redirect", (event, target) => {
    guardDshNavigation(url, target, event, openExternal)
  })
  const insetCss = titlebarInsetCss(process.platform)
  // insertCSS is scoped to one navigation, so re-publish on every load.
  if (insetCss) win.webContents.on("dom-ready", () => void win.webContents.insertCSS(insetCss))
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", () => win.webContents.setZoomFactor(1))
  win.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault()
    win.setTitle(pawworkWindowTitle(title))
  })
  void win.loadURL(url)
  win.once("ready-to-show", () => win.show())

  return win
}

function openExternal(target: string) {
  return shell.openExternal(target).catch((error) => {
    log.error("failed to open external URL", { target, error })
  })
}
