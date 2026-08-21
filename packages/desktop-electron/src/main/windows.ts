import windowState from "electron-window-state"
import log from "electron-log/main.js"
import { app, BrowserWindow, nativeImage, shell } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { macTrafficLightPosition, pawworkWindowTitle, titlebarInsetCss } from "./window-chrome"
import { STARTUP_URL, startupPageTarget, type StartupAction } from "./startup-page"
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

type MainWindowOptions = {
  preload: string
  // Read on every navigation rather than captured: the window is created before
  // DSH has an origin, and outlives the one it eventually gets.
  dshUrl: () => string | undefined
  onStartupAction: (action: StartupAction) => void
}

// A load that is superseded rejects with ERR_ABORTED, and an unhandled rejection
// in the main process is a crash. Superseding one is ordinary now: the startup
// page is replaced by DSH's own URL the moment DSH is ready, and replaced again
// by the failure page if it dies.
export function navigateWindow(win: BrowserWindow, url: string) {
  win.loadURL(url).catch((error) => log.error("failed to load URL", { url, error }))
}

export function createMainWindow(options: MainWindowOptions) {
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
    webPreferences: dshWebPreferences(options.preload),
  })

  state.manage(win)
  win.webContents.setWindowOpenHandler(({ url: target }) =>
    handleDshWindowOpen(options.dshUrl(), target, (destination) => navigateWindow(win, destination), openExternal))
  win.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) {
      // The startup page's buttons are links back into its own origin, and only
      // that page may spend them. Asked for from anywhere else — DSH renders
      // model output, and a link is the cheapest thing a model can emit — the
      // scheme falls to the ordinary guard, which denies everything but http.
      const startup = win.webContents.getURL().startsWith(STARTUP_URL)
        ? startupPageTarget(event.url)
        : undefined
      if (startup) {
        if (startup.kind === "page") return
        event.preventDefault()
        options.onStartupAction(startup.action)
        return
      }
      guardDshNavigation(options.dshUrl(), event.url, event, openExternal)
      return
    }
    if (decideDshNavigation(options.dshUrl(), event.url) !== "same-window") event.preventDefault()
  })
  win.webContents.on("will-redirect", (event, target) => {
    guardDshNavigation(options.dshUrl(), target, event, openExternal)
  })
  // insertCSS is scoped to one navigation and returns a key we have to hand back,
  // or a reload just stacks another copy of the same sheet. Publishes are chained
  // rather than run concurrently: two overlapping calls would both observe no key,
  // both insert, and the untracked sheet would survive the next removal as a dead
  // 32px strip that still swallows clicks.
  let insetKey: string | undefined
  let publishing = Promise.resolve()
  const publishTitlebarInset = (navigated = false) => {
    publishing = publishing.then(async () => {
      // A navigation drops every sheet insertCSS gave us, so the key is stale
      // rather than removable — reset it inside the chain, not beside it.
      if (navigated) insetKey = undefined
      if (insetKey !== undefined) {
        await win.webContents.removeInsertedCSS(insetKey).catch(() => undefined)
        insetKey = undefined
      }
      const css = titlebarInsetCss(process.platform, { fullscreen: win.isFullScreen() })
      if (css) insetKey = await win.webContents.insertCSS(css)
    }).catch(() => undefined)
    return publishing
  }
  win.webContents.on("dom-ready", () => void publishTitlebarInset(true))
  win.on("enter-full-screen", () => void publishTitlebarInset())
  win.on("leave-full-screen", () => void publishTitlebarInset())
  win.webContents.setZoomFactor(1)
  win.webContents.on("zoom-changed", () => win.webContents.setZoomFactor(1))
  win.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault()
    win.setTitle(pawworkWindowTitle(title))
  })
  navigateWindow(win, options.dshUrl() ?? STARTUP_URL)
  win.once("ready-to-show", () => win.show())

  return win
}

function openExternal(target: string) {
  return shell.openExternal(target).catch((error) => {
    log.error("failed to open external URL", { target, error })
  })
}
