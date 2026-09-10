import { readFileSync, writeFileSync } from "node:fs"
import type { WindowColorScheme } from "./window-options"

// The appearance the product last published, kept across runs so a window can
// be painted to match the app someone is about to see rather than their OS. It
// is a cache, not settings: DSH owns the real preference, and a missing or
// damaged file only costs one launch of the system appearance.
export function readStartupColorScheme(path: string): WindowColorScheme | undefined {
  try {
    const scheme = (JSON.parse(readFileSync(path, "utf8")) as { colorScheme?: unknown }).colorScheme
    return scheme === "dark" || scheme === "light" ? scheme : undefined
  } catch {
    return undefined
  }
}

export function writeStartupColorScheme(path: string, scheme: WindowColorScheme) {
  try {
    writeFileSync(path, `${JSON.stringify({ colorScheme: scheme })}\n`, "utf8")
  } catch {
    // A cache that cannot be written is still a cache; the next launch just
    // falls back to the system appearance.
  }
}
