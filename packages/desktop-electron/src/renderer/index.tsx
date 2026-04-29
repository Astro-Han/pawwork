// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@opencode-ai/app"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createResource, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { desktopShellMainSelector, titlebarShellSelector } from "./ci-smoke-selectors"
import { initI18n, t } from "./i18n"
import { getStartupState, pushPendingDeepLinks } from "./startup-state"
import { UPDATER_ENABLED } from "./updater"
import { webviewZoom } from "./webview-zoom"
import "./styles.css"
import { useTheme } from "@opencode-ai/ui/theme/context"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()
  .then((locale) =>
    window.api.initializeDesktopContext(locale).catch((error) => {
      console.debug("[desktop] initializeDesktopContext failed", error)
    }),
  )
  .catch((error) => {
    console.debug("[desktop] initI18n failed", error)
  })

const deepLinkEvent = "opencode:deep-link"
const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  pushPendingDeepLinks(window, urls)
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

async function reportCiSmokeReady(sidecar: { url: string; username?: string | null; password?: string | null }) {
  if (document.title !== "PawWork") return false
  if (!document.querySelector(titlebarShellSelector)) return false
  if (!document.querySelector(desktopShellMainSelector)) return false

  const windowCount = await window.api.getWindowCount().catch(() => 0)
  if (windowCount !== 1) return false

  const auth = btoa(`${sidecar.username ?? "opencode"}:${sidecar.password ?? ""}`)
  const res = await fetch(new URL("/global/health", sidecar.url), {
    headers: {
      authorization: `Basic ${auth}`,
    },
  }).catch(() => null)
  if (!res?.ok) return false

  await window.api.reportCiSmokeReady()
  return true
}

const listenForDeepLinks = () => {
  const startUrls = startupState.consumeInitialDeepLinks()
  if (startUrls.length) emitDeepLinks(startUrls)
  const dispose = window.api.onDeepLink((urls) => emitDeepLinks(urls))
  void window.api.reportDeepLinkReady()
  return dispose
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const wslHome = async () => {
    if (os !== "windows" || !startupState.wslEnabled()) return undefined
    return window.api.wslPath("~", "windows").catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    if (!result || !startupState.wslEnabled()) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => window.api.wslPath(path, "linux").catch(() => path))) as any
    }
    return window.api.wslPath(result, "linux").catch(() => result) as any
  }

  const resolveWslPath = async (path: string, mode: "windows" | "linux") => {
    if (!startupState.wslEnabled()) return path
    return window.api.wslPath(path, mode).catch(() => path)
  }

  const resolveWslPathForDirectRead = async (path: string) => {
    if (!startupState.wslEnabled()) return path
    return window.api.wslPath(path, "windows").catch(() => null)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return handleWslPicker(result)
    },

    async readFileDataUrl(path, mime) {
      const hostPath = await resolveWslPathForDirectRead(path)
      if (!hostPath) return null
      return window.api.readFileDataUrl(hostPath, mime).catch(() => null)
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    exportSession(sessionID, directory, defaultName) {
      return window.api.exportSession(sessionID, directory, defaultName)
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          if (startupState.wslEnabled()) {
            const converted = await window.api.wslPath(path, "windows").catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    async showItemInFolder(path: string) {
      const resolved = os === "windows" ? await resolveWslPath(path, "windows") : path
      return window.api.showItemInFolder(resolved)
    },

    async statPaths(paths: string[]) {
      const pairs = await Promise.all(
        paths.map(async (original) => {
          const resolved =
            os === "windows" && startupState.wslEnabled()
              ? await window.api.wslPath(original, "windows").catch(() => original)
              : original
          return [original, resolved] as const
        }),
      )
      const stats = await window.api.statPaths(pairs.map(([, resolved]) => resolved))
      return Object.fromEntries(
        pairs.map(([original, resolved]) => [original, stats[resolved] ?? { size: 0, exists: false }]),
      )
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    checkUpdate: async () => {
      if (!UPDATER_ENABLED()) return { updateAvailable: false, status: "disabled" }
      return window.api.checkUpdate()
    },

    reportProblem: (input) => window.api.reportProblem(input),

    update: async () => {
      if (!UPDATER_ENABLED()) return
      await window.api.installUpdate()
    },

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      // Omit `icon`; macOS/Windows fall back to the packaged app icon, which
      // is the PawWork paw-print. Any explicit URL here would pin us to an
      // external asset and reintroduce OpenCode branding in notifications.
      try {
        const notification = new Notification(title, {
          body: description ?? "",
        })
        notification.onclick = () => {
          void window.api.showWindow()
          void window.api.setWindowFocus()
          handleNotificationClick(href)
          notification.close()
        }
      } catch {
        // Fallback to IPC-based notification if native Notification fails
        window.api.showNotification(title, description)
      }

      // Flash Dock/taskbar to attract attention
      void window.api.flashFrame()
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getWslEnabled: async () => {
      const next = await window.api.getWslConfig().catch(() => null)
      if (next) {
        startupState.setWslEnabled(next.enabled)
        return next.enabled
      }
      return startupState.wslEnabled()
    },

    setWslEnabled: async (enabled) => {
      await window.api.setWslConfig({ enabled })
      startupState.setWslEnabled(enabled)
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
const startupState = getStartupState()
void startupState.ready.then(() => {
  listenForDeepLinks()

  render(() => {
    const platform = createPlatform()
    const loadLocale = async () => {
      const current = await platform.storage?.("pawwork.global.dat").getItem("language")
      const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
      const raw = current ?? legacy
      if (!raw) return
      const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
      if (!locale) return
      const next = normalizeLocale(locale)
      if (next !== "en") await loadLocaleDict(next)
      return next satisfies Locale
    }

    const [windowCount] = createResource(() => window.api.getWindowCount())

    // Fetch sidecar credentials (available immediately, before health check)
    const [sidecar] = createResource(() => window.api.awaitInitialization(() => undefined))

    const [defaultServer] = createResource(() =>
      platform.getDefaultServer?.().then((url) => {
        if (url) return ServerConnection.key({ type: "http", http: { url } })
      }),
    )
    const [locale] = createResource(loadLocale)
    let ciSmokeTaskStarted = false

    const servers = () => {
      const data = sidecar()
      if (!data) return []
      const server: ServerConnection.Sidecar = {
        displayName: "Local Server",
        type: "sidecar",
        variant: "base",
        http: {
          url: data.url,
          username: data.username ?? undefined,
          password: data.password ?? undefined,
        },
      }
      return [server] as ServerConnection.Any[]
    }

    function handleClick(e: MouseEvent) {
      const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
      if (link?.href) {
        e.preventDefault()
        platform.openLink(link.href)
      }
    }

    function Inner() {
      const cmd = useCommand()
      menuTrigger = (id) => cmd.trigger(id)

      const theme = useTheme()

      createEffect(() => {
        theme.themeId()
        theme.mode()
        const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
        if (bg) {
          void window.api.setBackgroundColor(bg)
        }
      })

      return null
    }

    createEffect(() => {
      if (!window.api.ciSmokeEnabled) return
      if (ciSmokeTaskStarted) return
      if (defaultServer.loading || sidecar.loading || windowCount.loading || locale.loading) return

      const readySidecar = sidecar.latest
      if (!readySidecar) return

      ciSmokeTaskStarted = true
      void (async () => {
        const timeoutAt = Date.now() + 15_000
        while (Date.now() < timeoutAt) {
          if (await reportCiSmokeReady(readySidecar)) return
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      })()
    })

    onMount(() => {
      document.addEventListener("click", handleClick)
      onCleanup(() => {
        document.removeEventListener("click", handleClick)
      })
    })

    return (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale={locale.latest}>
          <Show when={!defaultServer.loading && !sidecar.loading && !windowCount.loading && !locale.loading}>
            {(_) => {
              return (
                <AppInterface
                  defaultServer={defaultServer.latest ?? ServerConnection.Key.make("sidecar")}
                  servers={servers()}
                  router={MemoryRouter}
                >
                  <Inner />
                </AppInterface>
              )
            }}
          </Show>
        </AppBaseProviders>
      </PlatformProvider>
    )
  }, root!)
})
