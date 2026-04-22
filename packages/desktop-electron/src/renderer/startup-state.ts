import type { ElectronAPI, WindowConfig } from "../preload/types"

type DeepLinkWindow = Window & {
  __OPENCODE__?: {
    deepLinks?: string[]
  }
}

const closedConfig: WindowConfig = {
  updaterEnabled: false,
  wslEnabled: false,
}

const closedApi: Pick<ElectronAPI, "getWindowConfig" | "consumeInitialDeepLinks"> = {
  getWindowConfig: async () => closedConfig,
  consumeInitialDeepLinks: async () => [],
}

function defaultApi() {
  return typeof window === "undefined" ? closedApi : (window.api ?? closedApi)
}

// Consumers that need IPC-backed values must await ready before reading accessors.
export function createStartupState(api: Pick<ElectronAPI, "getWindowConfig" | "consumeInitialDeepLinks"> = defaultApi()) {
  let config = closedConfig
  let initialDeepLinks: string[] = []

  const ready = Promise.all([api.getWindowConfig(), api.consumeInitialDeepLinks()])
    .then(([nextConfig, nextDeepLinks]) => {
      config = nextConfig
      initialDeepLinks = Array.isArray(nextDeepLinks) ? nextDeepLinks : []
    })
    .catch((error) => {
      console.warn("[desktop] startup IPC failed", error)
      config = closedConfig
      initialDeepLinks = []
    })

  return {
    ready,
    updaterEnabled: () => config.updaterEnabled,
    wslEnabled: () => config.wslEnabled,
    setWslEnabled: (enabled: boolean) => {
      config = { ...config, wslEnabled: enabled }
    },
    consumeInitialDeepLinks: () => initialDeepLinks.splice(0),
  }
}

export function pushPendingDeepLinks(target: DeepLinkWindow, urls: string[]) {
  if (urls.length === 0) return
  target.__OPENCODE__ ??= {}
  const pending = target.__OPENCODE__.deepLinks ?? []
  pending.push(...urls)
  target.__OPENCODE__.deepLinks = pending
}

let startupState: ReturnType<typeof createStartupState> | undefined

export function getStartupState() {
  startupState ??= createStartupState()
  return startupState
}
