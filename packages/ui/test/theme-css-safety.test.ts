import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { resolveThemeVariant, themeToCss } from "../src/theme/resolve"
import type { ThemePaletteColors, ThemeVariant } from "../src/theme/types"

const ROOT = join(import.meta.dirname, "..")
const SCHEMA = JSON.parse(readFileSync(join(ROOT, "src/theme/desktop-theme.schema.json"), "utf-8"))

const PALETTE: ThemePaletteColors = {
  neutral: "#ffffff",
  ink: "#1a1613",
  primary: "#ff5910",
  success: "#2d9d5a",
  warning: "#e6a23c",
  error: "#d24a3a",
  info: "#2090f5",
}

function variant(overrides: Record<string, string>): ThemeVariant {
  return { palette: PALETTE, overrides }
}

describe("desktop theme CSS declaration safety", () => {
  test("schema keeps override keys and values declaration-safe", () => {
    const cssValuePattern = new RegExp(SCHEMA.definitions.CssValue.pattern)
    const keyPattern = new RegExp(SCHEMA.definitions.ThemeVariant.properties.overrides.propertyNames.pattern)

    expect(keyPattern.test("font-size-body")).toBe(true)
    expect(keyPattern.test("fg-strong")).toBe(true)
    expect(keyPattern.test("fg_strong")).toBe(false)

    expect(cssValuePattern.test("13px")).toBe(true)
    expect(cssValuePattern.test("1.6")).toBe(true)
    expect(cssValuePattern.test("rgba(0, 0, 0, 0.04)")).toBe(true)
    expect(cssValuePattern.test("var(--font-size-body)")).toBe(true)
    expect(cssValuePattern.test("0 6px 24px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.05)")).toBe(true)

    expect(cssValuePattern.test("13px; --fg-strong: red")).toBe(false)
    expect(cssValuePattern.test("13px } body { color: red")).toBe(false)
    expect(cssValuePattern.test("13px\n--fg-strong: red")).toBe(false)
  })

  test("runtime accepts legal typography and surface override values", () => {
    const tokens = resolveThemeVariant(
      variant({
        "font-size-body": "13px",
        "line-height-body": "1.6",
        "code-surface": "rgba(0, 0, 0, 0.04)",
        "shadow-raised": "0 6px 24px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.05)",
      }),
      false,
    )

    expect(tokens["font-size-body"]).toBe("13px")
    expect(tokens["line-height-body"]).toBe("1.6")
    expect(themeToCss({ "font-size-body": "13px", "code-surface": "rgba(0, 0, 0, 0.04)" })).toContain(
      "--font-size-body: 13px;",
    )
  })

  test("runtime rejects injected declarations and invalid override keys", () => {
    expect(() => resolveThemeVariant(variant({ "font-size-body": "13px; --fg-strong: red" }), false)).toThrow(
      /Invalid theme CSS value/,
    )
    expect(() => resolveThemeVariant(variant({ "font-size-body": "13px } body { color: red" }), false)).toThrow(
      /Invalid theme CSS value/,
    )
    expect(() => resolveThemeVariant(variant({ "fg_strong": "red" }), false)).toThrow(/Invalid theme token/)

    expect(() => themeToCss({ "font-size-body": "13px; --fg-strong: red" })).toThrow(/Invalid theme CSS value/)
    expect(() => themeToCss({ "font_size_body": "13px" })).toThrow(/Invalid theme token/)
  })
})
