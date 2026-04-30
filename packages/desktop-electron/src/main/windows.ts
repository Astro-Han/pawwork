import windowState from "electron-window-state"
import { app, BrowserWindow, nativeImage, net, protocol } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { rendererProtocol, rendererUrl, resolveRendererFile } from "./renderer-protocol"
import { macTrafficLightPosition } from "./window-chrome"
import { rendererWebPreferences } from "./window-options"

const root = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(root, "../renderer")
let rendererSchemeRegistered = false

let backgroundColor: string | undefined

export function setBackgroundColor(color: string) {
  backgroundColor = color
}

export function getBackgroundColor(): string | undefined {
  return backgroundColor
}

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return join(iconsDir(), `icon.${ext}`)
}

export function setDockIcon() {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(join(iconsDir(), "dock.png"))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function registerRendererScheme() {
  // Must run once before app.whenReady(); the guard only avoids duplicate pre-ready registration attempts.
  if (rendererSchemeRegistered) return
  protocol.registerSchemesAsPrivileged([
    {
      scheme: rendererProtocol,
      privileges: {
        secure: true,
        standard: true,
        corsEnabled: true,
        supportFetchAPI: true,
      },
    },
  ])
  rendererSchemeRegistered = true
}

export function registerRendererProtocol() {
  protocol.handle(rendererProtocol, (request) => {
    const file = resolveRendererFile(rendererRoot, request.url)
    if (!file) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

export function createMainWindow() {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800,
  })

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
    backgroundColor,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          trafficLightPosition: macTrafficLightPosition(),
        }
      : {}),
    webPreferences: rendererWebPreferences(root),
  })

  state.manage(win)
  loadWindow(win, "index.html")
  wireZoom(win)

  win.once("ready-to-show", () => {
    win.show()
  })

  return win
}

export function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    icon: iconPath(),
    backgroundColor,
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const } : {}),
    webPreferences: rendererWebPreferences(root),
  })

  if (process.platform === "win32") {
    win.removeMenu()
  }

  loadWindow(win, "loading.html")

  return win
}

function loadWindow(win: BrowserWindow, html: string) {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(html, devUrl)
    void win.loadURL(url.toString())
    return
  }

  void win.loadURL(rendererUrl(html))
}

function wireZoom(win: BrowserWindow) {
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1)
  })
}
