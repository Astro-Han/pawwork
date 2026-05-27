declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_PLUGIN_VERSION: string | undefined
  const OPENCODE_HTTP_VERSION: string | undefined
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
const DefinedInstallationPluginVersion =
  typeof OPENCODE_PLUGIN_VERSION === "string" && OPENCODE_PLUGIN_VERSION.trim() ? OPENCODE_PLUGIN_VERSION : undefined
if (!InstallationLocal && !DefinedInstallationPluginVersion) {
  throw new Error("OPENCODE_PLUGIN_VERSION must be defined for non-local builds")
}
export const InstallationPluginVersion =
  DefinedInstallationPluginVersion ?? "latest"

export const InstallationHTTPVersion =
  typeof OPENCODE_HTTP_VERSION === "string" && OPENCODE_HTTP_VERSION.trim()
    ? OPENCODE_HTTP_VERSION.trim()
    : InstallationVersion
