export function shouldQuitWhenAllWindowsClosed(platform: NodeJS.Platform) {
  return platform !== "darwin"
}

export function shouldCreateWindowOnActivate(platform: NodeJS.Platform, windowCount: number) {
  return platform === "darwin" && windowCount === 0
}

type RegisterWindowLifecycleOptions = {
  onWindowAllClosed: (listener: () => void) => void
  onActivate: (listener: () => void) => void
  quit: () => void
  getWindowCount: () => number
  openWindow: () => void
  platform: NodeJS.Platform
}

export function registerWindowLifecycle(options: RegisterWindowLifecycleOptions) {
  options.onWindowAllClosed(() => {
    if (shouldQuitWhenAllWindowsClosed(options.platform)) options.quit()
  })

  options.onActivate(() => {
    if (shouldCreateWindowOnActivate(options.platform, options.getWindowCount())) options.openWindow()
  })
}

type WindowLike = {
  isDestroyed: () => boolean
}

export function selectNextMainWindow<T extends WindowLike>(closedWindow: T, windows: T[]) {
  return windows.find((win) => win !== closedWindow && !win.isDestroyed()) ?? null
}

export function shouldQueueDeepLinks(hasWindow: boolean, windowReady: boolean) {
  return !hasWindow || !windowReady
}

export function takeQueuedDeepLinksForReadyWindow(pending: string[], windowReady: boolean) {
  if (!windowReady || pending.length === 0) return []
  return pending.splice(0)
}

export function shouldOpenWindowForExternalEvent(hasWindow: boolean, initialized: boolean) {
  return !hasWindow && initialized
}

export function selectCommandWindow<T extends WindowLike>(focusedWindow: T | null, currentWindow: T | null) {
  if (focusedWindow && !focusedWindow.isDestroyed()) return focusedWindow
  if (currentWindow && !currentWindow.isDestroyed()) return currentWindow
  return null
}
