import { TITLEBAR_HEIGHT } from "./window-chrome.ts"

export type WindowColorScheme = "light" | "dark"

// Every surface the window shows before the web app's own stylesheet applies —
// the native window background, the Windows caption overlay, the startup page —
// has to be the colour the web app is about to paint, or the difference shows as
// a flash or a permanent white strip. These are DSH's `--dsw-alias-bg-base`; a
// test in dsh-product-client.test.ts fails if the installed theme moves.
const SURFACE_COLOR: Record<WindowColorScheme, string> = { light: "#fff", dark: "#151517" }

export function windowSurfaceColor(colorScheme: WindowColorScheme) {
  return SURFACE_COLOR[colorScheme]
}

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
