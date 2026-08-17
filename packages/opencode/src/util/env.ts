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

// The PawWork desktop app injects XDG_* keys into the embedded server's
// process environment to namespace its config/data/cache/state directories.
// Those keys must not reach user-command children (PTY terminals, the bash
// tool): XDG-following CLIs would then treat PawWork's data directory as
// their config home and lose their real configuration (issue #1528). The
// injector (desktop-electron server.ts) publishes this restore instruction
// alongside the pollution: a JSON map of every injected key to the user's
// pre-existing value, or null when the user had none. Executing the
// instruction here keeps the injected-key list in exactly one place. The
// marker name is a wire contract with the injector (desktop-electron
// server.ts spells the same literal when publishing it). Returns every key
// that was deleted from the record — the unset keys plus the marker itself:
// a spawner that merges the parent environment (bun-pty) resurrects deleted
// keys and must blank-override each returned one.
const USER_ENV_RESTORE_INSTRUCTION_KEY = "PAWWORK_USER_ENV_RESTORE"

export function restoreUserEnv(env: Record<string, string | undefined>): string[] {
  const instruction = process.env[USER_ENV_RESTORE_INSTRUCTION_KEY]
  const deletedKeys: string[] = [USER_ENV_RESTORE_INSTRUCTION_KEY]
  delete env[USER_ENV_RESTORE_INSTRUCTION_KEY]
  if (!instruction) return deletedKeys
  let restore: Record<string, unknown>
  try {
    restore = JSON.parse(instruction)
  } catch {
    return deletedKeys
  }
  if (!restore || typeof restore !== "object") return deletedKeys
  for (const [key, value] of Object.entries(restore)) {
    if (typeof value === "string") env[key] = value
    else {
      delete env[key]
      deletedKeys.push(key)
    }
  }
  return deletedKeys
}

// Returns the directory holding PawWork's bundled CLI tools (uv, ...),
// or "" when not running inside the packaged Electron app (e.g. plain `bun dev`).
// In dev:desktop, process.resourcesPath points to the Electron framework's
// Resources, not PawWork's — there's no tools/ subdir there, so the prepend
// is a no-op (the directory simply doesn't exist on disk).
export function bundledToolsDir(): string {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  return resourcesPath ? path.join(resourcesPath, "tools") : ""
}

// Prepends bundledToolsDir to a PATH string so child processes can resolve
// PawWork's bundled CLIs (e.g. `uv`) by bare name. Pass the PATH that
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
