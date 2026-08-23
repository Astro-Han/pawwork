import { TITLEBAR_HEIGHT } from "./window-chrome.ts"

export type TitlebarColorScheme = "light" | "dark"

export function titleBarOverlayStyle(colorScheme: TitlebarColorScheme) {
  return {
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

export function dshTitleBarOptions(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return { titleBarOverlay: { height: TITLEBAR_HEIGHT }, titleBarStyle: "hidden" as const }
  }
  if (platform === "darwin") return { titleBarStyle: "hidden" as const }
  return {}
}
