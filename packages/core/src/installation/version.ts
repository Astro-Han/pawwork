declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_PLUGIN_VERSION: string | undefined
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

// Upstream opencode version this build follows for its OpenCode Zen HTTP identity
// (the User-Agent sent on LLM and models.dev requests). We share the OpenCode Zen
// backend with upstream opencode, so this keeps our outbound HTTP identity aligned
// with it. Bumped manually to track upstream releases.
export const InstallationHTTPVersion = "1.16.2"
