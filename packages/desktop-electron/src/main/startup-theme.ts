import { readFileSync, writeFileSync } from "node:fs"
import type { StartupColorScheme } from "./windows"

// The appearance the product last published, kept across runs so the startup
// page can match the app someone is about to see rather than their OS. It is a
// cache, not settings: DSH owns the real preference, and a missing or damaged
// file only costs one launch of the system default.
export function readStartupColorScheme(path: string): StartupColorScheme | undefined {
  try {
    const scheme = (JSON.parse(readFileSync(path, "utf8")) as { colorScheme?: unknown }).colorScheme
    return scheme === "dark" || scheme === "light" ? scheme : undefined
  } catch {
    return undefined
  }
}

export function writeStartupColorScheme(path: string, scheme: StartupColorScheme) {
  try {
    writeFileSync(path, `${JSON.stringify({ colorScheme: scheme })}\n`, "utf8")
  } catch {
    // A cache that cannot be written is still a cache; the next launch just
    // falls back to the system appearance.
  }
}
