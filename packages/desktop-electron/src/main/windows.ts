import windowState from "electron-window-state"
import log from "electron-log/main.js"
import { app, BrowserWindow, nativeImage, shell } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { macTrafficLightPosition, pawworkWindowTitle, titlebarInsetCss } from "./window-chrome"
import { decideDshNavigation, guardDshNavigation, handleDshWindowOpen } from "./window-navigation"
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
  win.webContents.setWindowOpenHandler(({ url: target }) =>
    handleDshWindowOpen(url, target, (destination) => win.loadURL(destination), openExternal))
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
  // insertCSS is scoped to one navigation and returns a key we have to hand back,
  // or a reload just stacks another copy of the same sheet.
  let insetKey: string | undefined
  const publishTitlebarInset = async () => {
    if (insetKey !== undefined) {
      await win.webContents.removeInsertedCSS(insetKey).catch(() => undefined)
      insetKey = undefined
    }
    const css = titlebarInsetCss(process.platform, { fullscreen: win.isFullScreen() })
    if (css) insetKey = await win.webContents.insertCSS(css)
  }
  win.webContents.on("dom-ready", () => {
    insetKey = undefined
    void publishTitlebarInset()
  })
  win.on("enter-full-screen", () => void publishTitlebarInset())
  win.on("leave-full-screen", () => void publishTitlebarInset())
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
