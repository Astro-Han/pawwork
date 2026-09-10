import { TITLEBAR_HEIGHT } from "./window-chrome.ts"

export type WindowColorScheme = "light" | "dark"

// Every surface the window shows before the web app's own stylesheet applies —
// the native window background, the Windows caption overlay, the startup page —
// is painted from here, and all of them have to agree. New values come from
// DSH's `--dsw-alias-bg-base`, in both of its themes.
export const SURFACE_COLOR = { light: "#fff", dark: "#151517" } as const satisfies Record<WindowColorScheme, string>

export function titleBarOverlayStyle(colorScheme: WindowColorScheme) {
  return {
    height: TITLEBAR_HEIGHT,
    color: SURFACE_COLOR[colorScheme],
    symbolColor: colorScheme === "dark" ? "#f0f0f0" : "#1f2328",
  }
}

export function dshWebPreferences(preload: string) {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload,
  }
}

export function dshTitleBarOptions(platform: NodeJS.Platform, colorScheme: WindowColorScheme) {
  if (platform === "win32") {
    return { titleBarOverlay: titleBarOverlayStyle(colorScheme), titleBarStyle: "hidden" as const }
  }
  if (platform === "darwin") return { titleBarStyle: "hidden" as const }
  return {}
}
