import { afterEach, describe, expect, mock, test } from "bun:test"

type KeydownHandler = (event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  preventDefault: () => void
}) => void

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator)
  else delete (globalThis as { navigator?: Navigator }).navigator
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else delete (globalThis as { window?: Window }).window
})

function deferred() {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function loadZoomModule(options?: { userAgent?: string; setZoomFactor?: (factor: number) => Promise<void> }) {
  const handlers: KeydownHandler[] = []
  const setZoomFactor = mock(options?.setZoomFactor ?? (() => Promise.resolve()))

  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: options?.userAgent ?? "Windows" },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, "window", {
    value: {
      api: { setZoomFactor },
      addEventListener: (type: string, handler: KeydownHandler) => {
        if (type === "keydown") handlers.push(handler)
      },
    },
    configurable: true,
    writable: true,
  })

  const module = await import(`./webview-zoom?webview-zoom-test=${crypto.randomUUID()}`)
  return {
    handler: handlers[0]!,
    setZoomFactor,
    webviewZoom: module.webviewZoom,
  }
}

function keyEvent(key: string, overrides?: Partial<Parameters<KeydownHandler>[0]>) {
  return {
    key,
    ctrlKey: true,
    metaKey: false,
    preventDefault: mock(() => undefined),
    ...overrides,
  }
}

describe("desktop renderer webview zoom", () => {
  test("only consumes keydown events that actually change zoom", async () => {
    const { handler, setZoomFactor } = await loadZoomModule()
    const unrelated = keyEvent("a")
    const zoomOut = keyEvent("-")

    handler(unrelated)
    handler(zoomOut)

    expect(unrelated.preventDefault).toHaveBeenCalledTimes(0)
    expect(zoomOut.preventDefault).toHaveBeenCalledTimes(1)
    expect(setZoomFactor).toHaveBeenCalledTimes(1)
    expect(setZoomFactor).toHaveBeenCalledWith(0.8)
  })

  test("keeps requested zoom separate until Electron accepts the zoom change", async () => {
    const zoom = deferred()
    const { handler, webviewZoom } = await loadZoomModule({ setZoomFactor: () => zoom.promise })

    handler(keyEvent("-"))

    expect(webviewZoom()).toBe(1)
    zoom.resolve()
    await zoom.promise
    await Promise.resolve()
    expect(webviewZoom()).toBe(0.8)
  })

  test("keeps the current zoom when Electron rejects the zoom change", async () => {
    const zoom = deferred()
    const { handler, webviewZoom } = await loadZoomModule({ setZoomFactor: () => zoom.promise })

    handler(keyEvent("-"))

    zoom.reject(new Error("zoom failed"))
    await zoom.promise.catch(() => undefined)
    await Promise.resolve()
    expect(webviewZoom()).toBe(1)
  })

  test("uses requested zoom for rapid repeated shortcuts", async () => {
    const { handler, setZoomFactor } = await loadZoomModule()

    handler(keyEvent("-"))
    handler(keyEvent("-"))
    handler(keyEvent("0"))

    const factors = setZoomFactor.mock.calls.map(([factor]) => factor)
    expect(factors).toHaveLength(3)
    expect(factors[0]).toBeCloseTo(0.8, 10)
    expect(factors[1]).toBeCloseTo(0.6, 10)
    expect(factors[2]).toBe(1)
  })
})
