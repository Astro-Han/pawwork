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
  show: () => {},
  loadURL: (async () => {}) as (url: string) => Promise<void>,
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
    show = win.show
    loadURL = win.loadURL
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  shell: { openExternal },
}))
vi.mock("electron-log/main.js", () => ({ default: { error: () => {} } }))
vi.mock("electron-window-state", () => ({
  default: () => ({ x: 0, y: 0, width: 1280, height: 800, manage: () => {} }),
}))

const { createMainWindow } = await import("./windows")

const DSH = "http://127.0.0.1:4321/"

beforeEach(() => {
  webContents.listeners.clear()
  win.listeners.clear()
  webContents.inserted.length = 0
  webContents.removed.length = 0
  webContents.nextKey = 0
  win.fullscreen = false
  openExternal.mockClear()
})

function navigate(url: string, isMainFrame: boolean) {
  const event = { isMainFrame, url, preventDefault: vi.fn(() => {}) }
  webContents.emit("will-frame-navigate", event)
  return event
}

describe("main window wiring", () => {
  test("holds a subframe to the DSH origin", () => {
    createMainWindow(DSH, "/preload.cjs")

    expect(navigate("http://127.0.0.1:4321/settings", false).preventDefault).not.toHaveBeenCalled()
    // A subframe that leaves the origin is stopped where it is: unlike the main
    // frame, it is not handed to the browser either.
    expect(navigate("https://example.com/phish", false).preventDefault).toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  test("sends a main-frame navigation off the origin to the browser instead", () => {
    createMainWindow(DSH, "/preload.cjs")

    expect(navigate("https://example.com/docs", true).preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs")
  })

  test("never opens a second window: same-origin loads here, everything else in the browser", () => {
    const loaded: string[] = []
    win.loadURL = async (url: string) => { loaded.push(url) }
    createMainWindow(DSH, "/preload.cjs")
    loaded.length = 0

    expect(webContents.windowOpenHandler!({ url: "http://127.0.0.1:4321/settings" })).toEqual({ action: "deny" })
    expect(loaded).toEqual(["http://127.0.0.1:4321/settings"])

    expect(webContents.windowOpenHandler!({ url: "https://example.com/docs" })).toEqual({ action: "deny" })
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs")
    expect(loaded).toEqual(["http://127.0.0.1:4321/settings"])
  })
})
