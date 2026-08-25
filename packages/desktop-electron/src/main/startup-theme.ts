import { readFileSync, writeFileSync } from "node:fs"
import type { StartupColorScheme } from "./windows"

// The appearance the product last published, kept across runs so the startup
// page can match the app someone is about to see rather than their OS. It is a
// cache, not settings: DSH owns the real preference, and a missing or damaged
// file only costs one launch of the system default.
type StartupThemeIo = {
  path: string
  read?: (path: string) => string
  write?: (path: string, contents: string) => void
}

export function readStartupColorScheme(io: StartupThemeIo): StartupColorScheme | undefined {
  const read = io.read ?? ((path: string) => readFileSync(path, "utf8"))
  try {
    const scheme = (JSON.parse(read(io.path)) as { colorScheme?: unknown }).colorScheme
    return scheme === "dark" || scheme === "light" ? scheme : undefined
  } catch {
    return undefined
  }
}

export function writeStartupColorScheme(io: StartupThemeIo, scheme: StartupColorScheme) {
  const write = io.write ?? ((path: string, contents: string) => writeFileSync(path, contents, "utf8"))
  try {
    write(io.path, `${JSON.stringify({ colorScheme: scheme })}\n`)
  } catch {
    // A cache that cannot be written is still a cache; the next launch just
    // falls back to the system appearance.
  }
}
