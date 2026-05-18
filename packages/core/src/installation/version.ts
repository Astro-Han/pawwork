declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_UPSTREAM_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationUpstreamVersion =
  typeof OPENCODE_UPSTREAM_VERSION === "string" ? OPENCODE_UPSTREAM_VERSION : InstallationVersion
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
