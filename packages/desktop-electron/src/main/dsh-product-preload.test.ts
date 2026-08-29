import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import vm from "node:vm"
import { describe, expect, vi, test } from "vitest"

const preloadPath = resolve(import.meta.dirname, "../../resources/dsh/product/preload.cjs")

describe("PawWork DSH product preload", () => {
  test("exposes the bridges before the document exists", () => {
    const exposed: string[] = []
    const listeners: Array<() => unknown> = []
    const styles: Array<{ textContent: string }> = []
    const document: {
      documentElement: null | { appendChild: (style: { textContent: string }) => void }
      addEventListener: (_event: string, listener: () => unknown) => void
      removeEventListener: (_event: string, listener: () => unknown) => void
      createElement: () => { textContent: string }
    } = {
      documentElement: null,
      addEventListener: (_event: string, listener: () => unknown) => listeners.push(listener),
      removeEventListener: (_event: string, listener: () => unknown) => listeners.splice(listeners.indexOf(listener), 1),
      createElement: () => ({ textContent: "" }),
    }

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      document,
      require: (name: string) => {
        if (name === "electron") {
          return {
            contextBridge: { exposeInMainWorld: (key: string) => exposed.push(key) },
            ipcRenderer: { invoke: () => {}, send: () => {} },
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect(listeners).toHaveLength(1)
    expect(exposed).toEqual(["pawworkLifecycle", "pawworkFiles", "pawworkCommunityMarket", "pawworkUpdater"])
    document.documentElement = { appendChild: (style: { textContent: string }) => void styles.push(style) }
    listeners[0]()
    expect(styles).toHaveLength(1)
    expect(listeners).toHaveLength(0)
  })

  test("reports product readiness through a one-way bridge", () => {
    const send = vi.fn(() => {})
    const exposed = new Map<string, Record<string, () => unknown>>()

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      require: (name: string) => {
        if (name === "electron") {
          return {
            contextBridge: { exposeInMainWorld: (key: string, api: Record<string, () => unknown>) => exposed.set(key, api) },
            ipcRenderer: { invoke: () => {}, send },
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect([...exposed.keys()]).toEqual(["pawworkLifecycle", "pawworkFiles", "pawworkCommunityMarket", "pawworkUpdater"])
    exposed.get("pawworkLifecycle")!.ready()
    expect(send).toHaveBeenCalledWith("pawwork:product-ready")
  })

  test("reports the web app color scheme whenever its theme changes", () => {
    const send = vi.fn(() => {})
    const exposed = new Map<string, Record<string, () => unknown>>()
    let colorScheme = "light"
    let changed: (() => void) | undefined
    const document = {
      documentElement: {
        appendChild: () => {},
        style: { get colorScheme() { return colorScheme } },
      },
      createElement: () => ({ textContent: "" }),
    }
    class MutationObserver {
      constructor(callback: () => void) { changed = callback }
      observe() {}
    }

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      document,
      matchMedia: () => ({ matches: false }),
      MutationObserver,
      require: (name: string) => {
        if (name === "electron") {
          return {
            contextBridge: { exposeInMainWorld: (key: string, api: Record<string, () => unknown>) => exposed.set(key, api) },
            ipcRenderer: { invoke: () => {}, send },
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect(send).not.toHaveBeenCalledWith("pawwork:titlebar-color-scheme", expect.anything())
    exposed.get("pawworkLifecycle")!.ready()
    expect(send.mock.calls).toEqual([
      ["pawwork:product-ready"],
      ["pawwork:titlebar-color-scheme", "light"],
    ])
    colorScheme = "dark"
    changed!()
    expect(send).toHaveBeenLastCalledWith("pawwork:titlebar-color-scheme", "dark")
  })

  test("does not replace the native startup theme before DSH declares its theme", () => {
    const send = vi.fn(() => {})
    const document = {
      documentElement: {
        appendChild: () => {},
        style: { colorScheme: "" },
      },
      createElement: () => ({ textContent: "" }),
    }

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      document,
      matchMedia: () => ({ addEventListener: () => {}, matches: true }),
      MutationObserver: class { observe() {} },
      require: (name: string) => {
        if (name === "electron") {
          return {
            contextBridge: { exposeInMainWorld: () => {} },
            ipcRenderer: { invoke: () => {}, send },
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect(send).not.toHaveBeenCalledWith("pawwork:titlebar-color-scheme", expect.anything())
    expect(document.documentElement.style.colorScheme).toBe("")
  })

  test("exposes only a no-argument native file picker", async () => {
    const pickerResult = { status: "selected", paths: ["/outside/report.txt"] }
    const invoke = vi.fn(async () => pickerResult)
    const exposed = new Map<string, Record<string, () => Promise<unknown>>>()
    const contextBridge = {
      exposeInMainWorld: (name: string, api: Record<string, () => Promise<unknown>>) => {
        exposed.set(name, api)
      },
    }

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      require: (name: string) => {
        if (name === "electron") return { contextBridge, ipcRenderer: { invoke } }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    const files = exposed.get("pawworkFiles")!
    expect(Object.keys(files)).toEqual(["pick"])
    await expect(files.pick()).resolves.toBe(pickerResult)
    expect(invoke).toHaveBeenCalledWith("pawwork:pick-conversation-files")
  })

  test("exposes only the bounded community-market operations", async () => {
    const invoke = vi.fn(async () => ({ enabled: false, version: null }))
    const send = vi.fn(() => {})
    const exposed = new Map<string, Record<string, (...args: unknown[]) => unknown>>()

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      require: (name: string) => {
        if (name === "electron") {
          return {
            contextBridge: { exposeInMainWorld: (key: string, api: Record<string, (...args: unknown[]) => unknown>) => exposed.set(key, api) },
            ipcRenderer: { invoke, send },
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    const api = exposed.get("pawworkCommunityMarket")!
    expect(Object.keys(api)).toEqual(["status", "enable", "disable", "restart"])
    await api.status()
    await api.enable()
    await api.disable()
    api.restart()
    expect(invoke.mock.calls).toEqual([
      ["pawwork:dsh-community-market:status"],
      ["pawwork:dsh-community-market:enable"],
      ["pawwork:dsh-community-market:disable"],
    ])
    expect(send).toHaveBeenCalledWith("pawwork:dsh-restart")
  })
  test("exposes the bounded updater bridge with a state subscription", async () => {
    const snapshot = { state: { status: "ready", version: "0.2.5" }, progress: null, currentVersion: "0.2.4" }
    const invoke = vi.fn(async () => snapshot)
    const send = vi.fn(() => {})
    const listeners = new Map<string, Array<(_event: unknown, payload: unknown) => void>>()
    const ipcRenderer = {
      invoke,
      send,
      on: (channel: string, listener: (_event: unknown, payload: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
      },
      removeListener: (channel: string, listener: (_event: unknown, payload: unknown) => void) => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((candidate) => candidate !== listener))
      },
    }
    const exposed = new Map<string, Record<string, (...args: unknown[]) => unknown>>()

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      require: (name: string) => {
        if (name === "electron") {
          return {
            contextBridge: { exposeInMainWorld: (key: string, api: Record<string, (...args: unknown[]) => unknown>) => exposed.set(key, api) },
            ipcRenderer,
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    const api = exposed.get("pawworkUpdater")!
    expect(Object.keys(api).sort()).toEqual(["check", "getState", "install", "openDownloadPage", "subscribe"])
    await expect(api.getState()).resolves.toBe(snapshot)
    await api.check()
    await api.install()
    api.openDownloadPage()
    expect(invoke.mock.calls).toEqual([
      ["pawwork:updater:get-state"],
      ["pawwork:updater:check"],
      ["pawwork:updater:install"],
    ])
    expect(send).toHaveBeenCalledWith("pawwork:updater:open-download-page")

    const received: unknown[] = []
    const unsubscribe = api.subscribe((payload: unknown) => received.push(payload)) as () => void
    for (const listener of listeners.get("pawwork:updater:state") ?? []) listener({}, snapshot)
    expect(received).toEqual([snapshot])
    unsubscribe()
    for (const listener of listeners.get("pawwork:updater:state") ?? []) listener({}, snapshot)
    expect(received).toEqual([snapshot])
  })

})
