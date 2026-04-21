import { expect, test } from "bun:test"

import {
  registerWindowLifecycle,
  selectCommandWindow,
  selectNextMainWindow,
  shouldCreateWindowOnActivate,
  shouldOpenWindowForExternalEvent,
  shouldQueueDeepLinks,
  shouldQuitWhenAllWindowsClosed,
  takeQueuedDeepLinksForReadyWindow,
} from "./window-lifecycle"

function createFakeApp() {
  const listeners = new Map<string, () => void>()
  let quitCount = 0

  return {
    on(event: string, listener: () => void) {
      listeners.set(event, listener)
    },
    quit() {
      quitCount++
    },
    emit(event: string) {
      listeners.get(event)?.()
    },
    quitCount() {
      return quitCount
    },
  }
}

test("macOS keeps the app running when the last window closes", () => {
  expect(shouldQuitWhenAllWindowsClosed("darwin")).toBe(false)
})

test("non-macOS platforms keep the existing quit-on-last-window behavior", () => {
  expect(shouldQuitWhenAllWindowsClosed("win32")).toBe(true)
  expect(shouldQuitWhenAllWindowsClosed("linux")).toBe(true)
})

test("macOS recreates a window on activate only when no windows are open", () => {
  expect(shouldCreateWindowOnActivate("darwin", 0)).toBe(true)
  expect(shouldCreateWindowOnActivate("darwin", 1)).toBe(false)
})

test("non-macOS activate does not create a window through macOS lifecycle rules", () => {
  expect(shouldCreateWindowOnActivate("win32", 0)).toBe(false)
  expect(shouldCreateWindowOnActivate("linux", 0)).toBe(false)
})

test("registered macOS lifecycle keeps the app alive and reopens a window on activate", () => {
  const fake = createFakeApp()
  let openCount = 0

  registerWindowLifecycle({
    onWindowAllClosed: (listener) => fake.on("window-all-closed", listener),
    onActivate: (listener) => fake.on("activate", listener),
    quit: () => fake.quit(),
    getWindowCount: () => 0,
    openWindow: () => {
      openCount++
    },
    platform: "darwin",
  })

  fake.emit("window-all-closed")
  fake.emit("activate")

  expect(fake.quitCount()).toBe(0)
  expect(openCount).toBe(1)
})

test("registered non-macOS lifecycle quits when all windows close", () => {
  const fake = createFakeApp()
  let openCount = 0

  registerWindowLifecycle({
    onWindowAllClosed: (listener) => fake.on("window-all-closed", listener),
    onActivate: (listener) => fake.on("activate", listener),
    quit: () => fake.quit(),
    getWindowCount: () => 0,
    openWindow: () => {
      openCount++
    },
    platform: "win32",
  })

  fake.emit("window-all-closed")
  fake.emit("activate")

  expect(fake.quitCount()).toBe(1)
  expect(openCount).toBe(0)
})

test("main window fallback keeps an older open window as the command target", () => {
  const olderWindow = { isDestroyed: () => false }
  const closingWindow = { isDestroyed: () => true }

  expect(selectNextMainWindow(closingWindow, [olderWindow])).toBe(olderWindow)
})

test("main window fallback ignores destroyed windows", () => {
  const closingWindow = { isDestroyed: () => true }
  const destroyedWindow = { isDestroyed: () => true }

  expect(selectNextMainWindow(closingWindow, [destroyedWindow])).toBeNull()
})

test("deep links are queued until the current window reports it is ready to receive them", () => {
  expect(shouldQueueDeepLinks(false, false)).toBe(true)
  expect(shouldQueueDeepLinks(true, false)).toBe(true)
  expect(shouldQueueDeepLinks(true, true)).toBe(false)
})

test("queued deep links flush once when the current window becomes ready", () => {
  const pending = ["opencode://open-project?directory=/a", "opencode://new-session?directory=/b"]

  expect(takeQueuedDeepLinksForReadyWindow(pending, false)).toEqual([])
  expect(pending).toEqual(["opencode://open-project?directory=/a", "opencode://new-session?directory=/b"])
  expect(takeQueuedDeepLinksForReadyWindow(pending, true)).toEqual([
    "opencode://open-project?directory=/a",
    "opencode://new-session?directory=/b",
  ])
  expect(pending).toEqual([])
  expect(takeQueuedDeepLinksForReadyWindow(pending, true)).toEqual([])
})

test("headless external events reopen a window only after initialization is done", () => {
  expect(shouldOpenWindowForExternalEvent(false, true)).toBe(true)
  expect(shouldOpenWindowForExternalEvent(false, false)).toBe(false)
  expect(shouldOpenWindowForExternalEvent(true, true)).toBe(false)
})

test("menu commands prefer the focused window over the newest tracked window", () => {
  const focusedWindow = { isDestroyed: () => false }
  const currentWindow = { isDestroyed: () => false }

  expect(selectCommandWindow(focusedWindow, currentWindow)).toBe(focusedWindow)
})

test("menu commands fall back to the tracked window when there is no focused window", () => {
  const currentWindow = { isDestroyed: () => false }

  expect(selectCommandWindow(null, currentWindow)).toBe(currentWindow)
})
