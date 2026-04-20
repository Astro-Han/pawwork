import { describe, expect, test } from "bun:test"
import {
  backgroundModeFromResponse,
  consumeColorResponseBuffer,
  type TerminalColorState,
} from "../../../src/cli/cmd/tui/util/terminal"

describe("backgroundModeFromResponse", () => {
  test("ignores partial OSC 11 payloads until the terminator arrives", () => {
    expect(backgroundModeFromResponse("\x1b]11;rgb:ffff/ffff/")).toBeUndefined()
  })

  test("parses BEL-terminated OSC 11 responses", () => {
    expect(backgroundModeFromResponse("\x1b]11;#ffffff\x07")).toBe("light")
  })

  test("parses ST-terminated OSC 11 responses", () => {
    expect(backgroundModeFromResponse("\x1b]11;#000000\x1b\\")).toBe("dark")
  })
})

describe("consumeColorResponseBuffer", () => {
  test("waits for full OSC terminators before parsing chunked color replies", () => {
    const state: TerminalColorState = {
      background: null,
      foreground: null,
      colors: [],
    }

    let buffer = consumeColorResponseBuffer("\x1b]11;#ff", state)
    expect(state.background).toBeNull()
    expect(buffer).toBe("\x1b]11;#ff")

    buffer = consumeColorResponseBuffer(buffer + "ffff\x07\x1b]10;#000000\x07\x1b]4;7;#abcdef\x07", state)
    expect(buffer).toBe("")
    expect(state.background).not.toBeNull()
    expect(state.foreground).not.toBeNull()
    expect(state.colors[7]).toBeDefined()
    const background = state.background
    const foreground = state.foreground
    const palette = state.colors[7]
    if (!background || !foreground || !palette) throw new Error("expected parsed colors")
    expect(background.r).toBeCloseTo(1)
    expect(foreground.r).toBeCloseTo(0)
    expect(palette.g).toBeCloseTo(0xcd / 255)
  })
})
