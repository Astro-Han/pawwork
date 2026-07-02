import { describe, expect, test } from "bun:test"
import { icons } from "./icon"
import { resolveCommandIconSvg, SKILL_GLYPH } from "./command-icon"

const CommandDefault = await Bun.file(
  new URL("../assets/icons/command-default.svg", import.meta.url),
).text()

describe("SKILL_GLYPH", () => {
  // command-icon.tsx inlines the skill glyph instead of importing the ~140KB
  // icon.tsx registry (which also breaks bun's export analysis on Windows).
  // This guards the inlined copy against drift from icon.tsx's source of truth.
  test("stays in sync with the chrome icon registry's skill entry", () => {
    expect(SKILL_GLYPH).toBe(icons.skill)
  })
})

describe("resolveCommandIconSvg", () => {
  test("returns the SVG string for a known icon key", () => {
    const result = resolveCommandIconSvg("command")
    expect(result).toBe(CommandDefault)
    expect(result).toMatch(/<svg\b/)
  })

  test("falls back to the default command SVG for an unknown key", () => {
    const result = resolveCommandIconSvg("nonexistent-icon-xyz")
    expect(result).toBe(CommandDefault)
  })

  test("returns a string (not JSX or reactive)", () => {
    const result = resolveCommandIconSvg("command")
    expect(typeof result).toBe("string")
  })

  test("fallback matches what CommandIcon would render", () => {
    // The fallback rule: REGISTRY[icon] ?? REGISTRY.command
    // For unknown icons, both helpers must return the same thing.
    const unknown = resolveCommandIconSvg("definitely-not-registered")
    const known = resolveCommandIconSvg("command")
    expect(unknown).toBe(known)
  })
})
