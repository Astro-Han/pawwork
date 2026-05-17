import path from "path"

const INTERNAL_SERVER_AUTH_ENV = new Set(["opencode_server_password", "opencode_server_username"])

export function withoutInternalServerAuthEnv<T extends Record<string, string | undefined>>(env: T): T {
  const sanitized = { ...env }
  for (const key of Object.keys(sanitized)) {
    if (INTERNAL_SERVER_AUTH_ENV.has(key.toLowerCase())) delete sanitized[key]
  }
  return sanitized
}

export function envValueCaseInsensitive(env: Record<string, string | undefined> | undefined, name: string) {
  const normalized = name.toLowerCase()
  return Object.entries(env ?? {}).find(([key]) => key.toLowerCase() === normalized)?.[1]
}

// Returns the directory holding PawWork's bundled CLI tools (officecli, ...),
// or "" when not running inside the packaged Electron app (e.g. plain `bun dev`).
// In dev:desktop, process.resourcesPath points to the Electron framework's
// Resources, not PawWork's — there's no tools/ subdir there, so the prepend
// is a no-op (the directory simply doesn't exist on disk).
export function bundledToolsDir(): string {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  return resourcesPath ? path.join(resourcesPath, "tools") : ""
}

// Prepends bundledToolsDir to a PATH string so child processes can resolve
// PawWork's bundled CLIs (e.g. `officecli`) by bare name. Pass the PATH that
// will end up in the spawned env; pass "" if unknown.
export function prependBundledTools(currentPath: string): string {
  const dir = bundledToolsDir()
  if (!dir) return currentPath
  // Don't append a trailing delimiter when currentPath is empty: on POSIX an
  // empty PATH segment is interpreted as the current directory, which weakens
  // command-resolution safety (cwd-shadowing of system commands).
  return currentPath ? `${dir}${path.delimiter}${currentPath}` : dir
}

// Removes every case-variant of the PATH key from an env record in place.
// Use before writing back a canonical `PATH` to a merged env, otherwise on
// Windows the result can carry both `Path` (inherited from process.env) and
// `PATH` (added explicitly); spawn then forwards both to the child with
// implementation-defined precedence.
export function stripPathKeys(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key]
  }
}
