export function sidebarMode(
  platform: NodeJS.Platform,
  packaged: boolean,
  setting: string | undefined,
  argv: string[],
): boolean {
  if (setting === "false") return false
  return setting === "true" || argv.includes("--sidebar") || (platform === "win32" && packaged)
}

export function quitWhenAllWindowsClosed(platform: NodeJS.Platform, sidebar: boolean): boolean {
  return platform !== "darwin" && !sidebar
}
