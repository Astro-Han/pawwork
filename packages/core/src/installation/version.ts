declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_PLUGIN_VERSION: string | undefined
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationPluginVersion =
  typeof OPENCODE_PLUGIN_VERSION === "string" && OPENCODE_PLUGIN_VERSION ? OPENCODE_PLUGIN_VERSION : "latest"
