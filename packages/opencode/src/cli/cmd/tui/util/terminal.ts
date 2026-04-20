import { RGBA } from "@opentui/core"

export type Colors = Awaited<ReturnType<typeof colors>>

export type TerminalColorState = {
  background: RGBA | null
  foreground: RGBA | null
  colors: RGBA[]
}

function parseHex(color: string): RGBA | null {
  const value = color.slice(1)
  if (value.length === 3) {
    return RGBA.fromInts(
      parseInt(value[0] + value[0], 16),
      parseInt(value[1] + value[1], 16),
      parseInt(value[2] + value[2], 16),
      255,
    )
  }
  if (value.length === 6) {
    return RGBA.fromInts(
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
      255,
    )
  }
  return null
}

function parse(color: string): RGBA | null {
  if (color.startsWith("rgb:")) {
    const parts = color.substring(4).split("/")
    return RGBA.fromInts(parseInt(parts[0], 16) >> 8, parseInt(parts[1], 16) >> 8, parseInt(parts[2], 16) >> 8, 255)
  }
  if (color.startsWith("#")) {
    return parseHex(color)
  }
  if (color.startsWith("rgb(")) {
    const parts = color.substring(4, color.length - 1).split(",")
    return RGBA.fromInts(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]), 255)
  }
  return null
}

function mode(bg: RGBA | null): "dark" | "light" {
  if (!bg) return "dark"
  const luminance = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b
  return luminance > 0.5 ? "light" : "dark"
}

export function backgroundModeFromResponse(buffer: string): "dark" | "light" | undefined {
  const match = buffer.match(/\x1b]11;([^\x07\x1b]+)(?:\x07|\x1b\\)/)
  if (!match) return
  return mode(parse(match[1]))
}

const COLOR_RESPONSE = /\x1b](10|11|4);(?:(\d+);)?([^\x07\x1b]+)(?:\x07|\x1b\\)/g

export function consumeColorResponseBuffer(buffer: string, state: TerminalColorState) {
  let consumedUntil = 0

  for (const match of buffer.matchAll(COLOR_RESPONSE)) {
    const type = match[1]
    const color = parse(match[3])
    if (type === "10") {
      state.foreground = color
    }
    if (type === "11") {
      state.background = color
    }
    if (type === "4") {
      const index = parseInt(match[2], 10)
      if (color) state.colors[index] = color
    }
    const end = (match.index ?? 0) + match[0].length
    if (end > consumedUntil) consumedUntil = end
  }

  return consumedUntil > 0 ? buffer.slice(consumedUntil) : buffer
}

/**
 * Query terminal colors including background, foreground, and palette (0-15).
 * Uses OSC escape sequences to retrieve actual terminal color values.
 *
 * Note: OSC 4 (palette) queries may not work through tmux as responses are filtered.
 * OSC 10/11 (foreground/background) typically work in most environments.
 *
 * Returns an object with background, foreground, and colors array.
 * Any query that fails will be null/empty.
 */
export async function colors(): Promise<{
  background: RGBA | null
  foreground: RGBA | null
  colors: RGBA[]
}> {
  if (!process.stdin.isTTY) return { background: null, foreground: null, colors: [] }

  return new Promise((resolve) => {
    const state: TerminalColorState = {
      background: null,
      foreground: null,
      colors: [],
    }
    let buffer = ""
    let timeout: NodeJS.Timeout

    const cleanup = () => {
      process.stdin.setRawMode(false)
      process.stdin.removeListener("data", handler)
      clearTimeout(timeout)
    }

    const handler = (data: Buffer) => {
      buffer += data.toString()
      buffer = consumeColorResponseBuffer(buffer, state)

      // Return immediately if we have all 16 palette colors
      if (state.colors.filter((c) => c !== undefined).length === 16) {
        cleanup()
        resolve({ background: state.background, foreground: state.foreground, colors: state.colors })
      }
    }

    process.stdin.setRawMode(true)
    process.stdin.on("data", handler)

    // Query background (OSC 11)
    process.stdout.write("\x1b]11;?\x07")
    // Query foreground (OSC 10)
    process.stdout.write("\x1b]10;?\x07")
    // Query palette colors 0-15 (OSC 4)
    for (let i = 0; i < 16; i++) {
      process.stdout.write(`\x1b]4;${i};?\x07`)
    }

    timeout = setTimeout(() => {
      cleanup()
      resolve({ background: state.background, foreground: state.foreground, colors: state.colors })
    }, 1000)
  })
}

// Keep startup mode detection separate from `colors()`: the TUI boot path only
// needs OSC 11 and should resolve on the first background response instead of
// waiting on the full palette query used by system theme generation.
export async function getTerminalBackgroundColor(): Promise<"dark" | "light"> {
  if (!process.stdin.isTTY) return "dark"

  return new Promise((resolve) => {
    let timeout: NodeJS.Timeout
    let buffer = ""

    const cleanup = () => {
      process.stdin.setRawMode(false)
      process.stdin.removeListener("data", handler)
      clearTimeout(timeout)
    }

    const handler = (data: Buffer) => {
      buffer += data.toString()
      const next = backgroundModeFromResponse(buffer)
      if (!next) return
      cleanup()
      resolve(next)
    }

    process.stdin.setRawMode(true)
    process.stdin.on("data", handler)
    process.stdout.write("\x1b]11;?\x07")

    timeout = setTimeout(() => {
      cleanup()
      resolve("dark")
    }, 1000)
  })
}
