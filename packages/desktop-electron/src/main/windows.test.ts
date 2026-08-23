import { beforeEach, describe, expect, test, vi } from "vitest"

// createMainWindow is pure wiring: it decides nothing itself, it attaches the
// decisions made in window-navigation and window-chrome to the right Electron
// events. Nothing covered that wiring, so the subframe navigation guard and the
// per-navigation reset of the inserted stylesheet could both be deleted with
// every suite green.

type Listener = (...args: unknown[]) => unknown

const webContents = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  inserted: [] as string[],
  removed: [] as string[],
  nextKey: 0,
  windowOpenHandler: undefined as ((details: { url: string }) => unknown) | undefined,
  on(event: string, listener: Listener) {
    const existing = webContents.listeners.get(event) ?? []
    webContents.listeners.set(event, [...existing, listener])
  },
  emit(event: string, ...args: unknown[]) {
    for (const listener of webContents.listeners.get(event) ?? []) listener(...args)
  },
  setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
    webContents.windowOpenHandler = handler
  },
  async insertCSS(css: string) {
    webContents.inserted.push(css)
    webContents.nextKey += 1
    return `key-${webContents.nextKey}`
  },
  async removeInsertedCSS(key: string) {
    webContents.removed.push(key)
  },
  setZoomFactor: () => {},
  url: "",
  getURL: () => webContents.url,
  reload: () => {},
}))

const win = vi.hoisted(() => ({
  webContents,
  listeners: new Map<string, Listener[]>(),
  fullscreen: false,
  on(event: string, listener: Listener) {
    const existing = win.listeners.get(event) ?? []
    win.listeners.set(event, [...existing, listener])
  },
  once: () => {},
  emit(event: string) {
    for (const listener of win.listeners.get(event) ?? []) listener()
  },
  isFullScreen: () => win.fullscreen,
  setTitle: () => {},
  setTitleBarOverlay: vi.fn(() => {}),
  show: () => {},
  loaded: [] as string[],
  async loadURL(url: string) {
    win.loaded.push(url)
  },
}))

const openExternal = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("electron", () => ({
  app: { isPackaged: false, dock: undefined },
  BrowserWindow: class {
    webContents = webContents
    on = win.on
    once = win.once
    isFullScreen = win.isFullScreen
    setTitle = win.setTitle
    setTitleBarOverlay = win.setTitleBarOverlay
    show = win.show
    loadURL = win.loadURL
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal },
}))
vi.mock("electron-log/main.js", () => ({ default: { error: () => {} } }))
vi.mock("electron-window-state", () => ({
  default: () => ({ x: 0, y: 0, width: 1280, height: 800, manage: () => {} }),
}))

const { createMainWindow, setTitlebarColorScheme, STARTUP_URL } = await import("./windows")

const DSH = "http://127.0.0.1:4321/"

function openWindow(dshUrl?: string) {
  webContents.url = dshUrl ?? STARTUP_URL
  return createMainWindow({
    preload: "/preload.cjs",
    dshUrl: () => dshUrl,
  })
}

beforeEach(() => {
  webContents.listeners.clear()
  win.listeners.clear()
  webContents.inserted.length = 0
  webContents.removed.length = 0
  webContents.nextKey = 0
  win.fullscreen = false
  webContents.url = ""
  win.loaded.length = 0
  win.setTitleBarOverlay.mockClear()
  openExternal.mockClear()
})

function navigate(url: string, isMainFrame: boolean) {
  const event = { isMainFrame, url, preventDefault: vi.fn(() => {}) }
  webContents.emit("will-frame-navigate", event)
  return event
}

describe("main window wiring", () => {
  test("updates Windows caption symbols from the web app theme", () => {
    setTitlebarColorScheme(win, "win32", "dark")

    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      color: "transparent",
      height: 32,
      symbolColor: "#f0f0f0",
    })
    setTitlebarColorScheme(win, "darwin", "light")
    setTitlebarColorScheme(win, "win32", "sepia")
    expect(win.setTitleBarOverlay).toHaveBeenCalledTimes(1)
  })

  test("holds a subframe to the DSH origin", () => {
    openWindow(DSH)

    expect(navigate("http://127.0.0.1:4321/settings", false).preventDefault).not.toHaveBeenCalled()
    // A subframe that leaves the origin is stopped where it is: unlike the main
    // frame, it is not handed to the browser either.
    expect(navigate("https://example.com/phish", false).preventDefault).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  test("sends a main-frame navigation off the origin to the browser instead", () => {
    openWindow(DSH)

    expect(navigate("https://example.com/docs", true).preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs")
  })

  test("never opens a second window: same-origin loads here, everything else in the browser", () => {
    openWindow(DSH)
    win.loaded.length = 0

    expect(webContents.windowOpenHandler!({ url: "http://127.0.0.1:4321/settings" })).toEqual({ action: "deny" })
    expect(win.loaded).toEqual(["http://127.0.0.1:4321/settings"])

    expect(webContents.windowOpenHandler!({ url: "https://example.com/docs" })).toEqual({ action: "deny" })
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs")
    expect(win.loaded).toEqual(["http://127.0.0.1:4321/settings"])
  })

  // The window is created before DSH has an origin and has to show something in
  // the meantime; loading nothing is what the 30-second blank start used to be.
  test("opens on the local startup page until DSH has a URL", () => {
    openWindow()
    expect(win.loaded).toEqual([STARTUP_URL])

    win.loaded.length = 0
    openWindow(DSH)
    expect(win.loaded).toEqual([DSH])
  })

  // With no origin to belong to, nothing belongs to it — including the page DSH
  // was showing a moment before it died.
  test("denies every DSH-origin navigation once the runtime is gone", () => {
    openWindow()
    webContents.url = STARTUP_URL

    expect(navigate("http://127.0.0.1:4321/settings", true).preventDefault).toHaveBeenCalled()
    expect(navigate("http://127.0.0.1:4321/settings", false).preventDefault).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})
