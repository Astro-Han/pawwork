import windowState from "electron-window-state"
import { app, BrowserWindow, nativeImage, nativeTheme, net, protocol } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { TitlebarTheme } from "../preload/types"
import { rendererProtocol, rendererUrl, resolveRendererFile } from "./renderer-protocol"
import { WINDOWS_TITLEBAR_OVERLAY_HEIGHT, macTrafficLightPosition } from "./window-chrome"
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

function tone() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light"
}

function overlay(theme: Partial<TitlebarTheme> = {}) {
  const mode = theme.mode ?? tone()
  return {
    color: "#00000000",
    symbolColor: mode === "dark" ? "white" : "black",
    height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
  }
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(theme))
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

  const mode = tone()
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
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
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
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
  const mode = tone()
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    icon: iconPath(),
    backgroundColor,
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const } : {}),
    ...(process.platform === "win32"
      ? {
          frame: false,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: overlay({ mode }),
        }
      : {}),
    webPreferences: rendererWebPreferences(root),
  })

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
