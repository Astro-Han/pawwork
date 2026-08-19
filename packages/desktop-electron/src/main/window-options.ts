export function dshWebPreferences(preload: string) {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload,
  }
}

export function dshTitleBarOptions(platform: NodeJS.Platform) {
  if (platform === "win32") return { titleBarOverlay: true as const, titleBarStyle: "hidden" as const }
  if (platform === "darwin") return { titleBarStyle: "hidden" as const }
  return {}
}
