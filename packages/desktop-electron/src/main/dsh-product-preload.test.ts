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
    expect(exposed).toEqual(["pawworkLifecycle", "pawworkFiles"])
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

    expect([...exposed.keys()]).toEqual(["pawworkLifecycle", "pawworkFiles"])
    exposed.get("pawworkLifecycle")!.ready()
    expect(send).toHaveBeenCalledWith("pawwork:product-ready")
  })

  test("reports the web app color scheme whenever its theme changes", () => {
    const send = vi.fn(() => {})
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
            contextBridge: { exposeInMainWorld: () => {} },
            ipcRenderer: { invoke: () => {}, send },
          }
        }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect(send).toHaveBeenCalledWith("pawwork:titlebar-color-scheme", "light")
    colorScheme = "dark"
    changed!()
    expect(send).toHaveBeenLastCalledWith("pawwork:titlebar-color-scheme", "dark")
  })

  test("exposes only a no-argument native file picker", async () => {
    const pickerResult = { status: "selected", paths: ["/outside/report.txt"] }
    const invoke = vi.fn(async () => pickerResult)
    let exposed: { name: string; api: Record<string, () => Promise<unknown>> } | undefined
    const contextBridge = {
      exposeInMainWorld: (name: string, api: Record<string, () => Promise<unknown>>) => {
        exposed = { name, api }
      },
    }

    vm.runInNewContext(readFileSync(preloadPath, "utf8"), {
      require: (name: string) => {
        if (name === "electron") return { contextBridge, ipcRenderer: { invoke } }
        throw new Error(`unexpected preload dependency: ${name}`)
      },
    })

    expect(exposed?.name).toBe("pawworkFiles")
    expect(Object.keys(exposed?.api ?? {})).toEqual(["pick"])
    await expect(exposed!.api.pick()).resolves.toBe(pickerResult)
    expect(invoke).toHaveBeenCalledWith("pawwork:pick-conversation-files")
  })

})
