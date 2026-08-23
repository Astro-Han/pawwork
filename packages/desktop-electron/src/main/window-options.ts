import { TITLEBAR_HEIGHT } from "./window-chrome.ts"

export type TitlebarColorScheme = "light" | "dark"

export function titleBarOverlayStyle(colorScheme: TitlebarColorScheme) {
  return {
    color: "transparent",
    height: TITLEBAR_HEIGHT,
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

export function dshTitleBarOptions(platform: NodeJS.Platform, colorScheme: TitlebarColorScheme = "light") {
  if (platform === "win32") {
    return { titleBarOverlay: titleBarOverlayStyle(colorScheme), titleBarStyle: "hidden" as const }
  }
  if (platform === "darwin") return { titleBarStyle: "hidden" as const }
  return {}
}
