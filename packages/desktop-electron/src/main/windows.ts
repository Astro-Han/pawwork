import windowState from "electron-window-state"
import { app, BrowserWindow, nativeImage, shell } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { macTrafficLightPosition } from "./window-chrome"
import { decideDshNavigation } from "./window-navigation"
import { dshWebPreferences } from "./window-options"

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

export function createMainWindow(url: string) {
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
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: macTrafficLightPosition(),
        }
      : {}),
    webPreferences: dshWebPreferences(),
  })

  state.manage(win)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    const decision = decideDshNavigation(url, target)
    if (decision === "same-window") void win.loadURL(target)
    if (decision === "external") void shell.openExternal(target)
    return { action: "deny" }
  })
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", () => win.webContents.setZoomFactor(1))
  void win.loadURL(url)
  win.once("ready-to-show", () => win.show())

  return win
}
