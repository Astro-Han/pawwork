/**
 * #642 PR1 typography utility parity.
 *
 * Locks the new role utility surface to the theme.css source-of-truth tokens.
 * PR2 can then migrate callsites without re-deciding the role values.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const THEME_CSS = readFileSync(join(ROOT, "src/styles/theme.css"), "utf-8")
const TAILWIND_CSS = readFileSync(
  join(ROOT, "src/styles/tailwind/index.css"),
  "utf-8",
)

type Role = {
  className: string
  family: "sans" | "mono"
  size: string
  weight: string
  lineHeight: string
  letterSpacing?: string
}

const ROLES: Role[] = [
  {
    className: "text-display",
    family: "sans",
    size: "font-size-display",
    weight: "font-weight-display",
    lineHeight: "line-height-display",
    letterSpacing: "letter-spacing-display",
  },
  {
    className: "text-h1",
    family: "sans",
    size: "font-size-h1",
    weight: "font-weight-h1",
    lineHeight: "line-height-h1",
    letterSpacing: "letter-spacing-h1",
  },
  {
    className: "text-h2",
    family: "sans",
    size: "font-size-h2",
    weight: "font-weight-h2",
    lineHeight: "line-height-h2",
  },
  {
    className: "text-h3",
    family: "sans",
    size: "font-size-h3",
    weight: "font-weight-h3",
    lineHeight: "line-height-h3",
  },
  {
    className: "text-body",
    family: "sans",
    size: "font-size-body",
    weight: "font-weight-body",
    lineHeight: "line-height-body",
  },
  {
    className: "text-caption",
    family: "sans",
    size: "font-size-caption",
    weight: "font-weight-caption",
    lineHeight: "line-height-caption",
  },
  {
    className: "text-mono",
    family: "mono",
    size: "font-size-mono",
    weight: "font-weight-mono",
    lineHeight: "line-height-mono",
  },
  {
    className: "text-mono-small",
    family: "mono",
    size: "font-size-mono-small",
    weight: "font-weight-mono-small",
    lineHeight: "line-height-mono-small",
  },
  {
    className: "text-kbd",
    family: "mono",
    size: "font-size-kbd",
    weight: "font-weight-kbd",
    lineHeight: "line-height-kbd",
  },
]

const EXPECTED_VALUES = new Map<string, string>([
  ["font-size-display", "28px"],
  ["font-size-h1", "20px"],
  ["font-size-h2", "16px"],
  ["font-size-h3", "13px"],
  ["font-size-body", "13px"],
  ["font-size-caption", "13px"],
  ["font-size-mono", "13px"],
  ["font-size-mono-small", "12px"],
  ["font-size-kbd", "11px"],
  ["font-weight-display", "500"],
  ["font-weight-h1", "500"],
  ["font-weight-h2", "500"],
  ["font-weight-h3", "500"],
  ["font-weight-body", "400"],
  ["font-weight-caption", "400"],
  ["font-weight-mono", "400"],
  ["font-weight-mono-small", "400"],
  ["font-weight-kbd", "500"],
  ["line-height-display", "1.3"],
  ["line-height-h1", "1.3"],
  ["line-height-h2", "1.5"],
  ["line-height-h3", "1.5"],
  ["line-height-body", "1.6"],
  ["line-height-caption", "1.3"],
  ["line-height-mono", "1.5"],
  ["line-height-mono-small", "1.5"],
  ["line-height-kbd", "1.3"],
  ["letter-spacing-display", "-0.32px"],
  ["letter-spacing-h1", "-0.16px"],
])

function extractBlock(css: string, headerPattern: RegExp): string {
  const match = headerPattern.exec(css)
  if (!match) return ""
  const open = match.index + match[0].lastIndexOf("{")
  let depth = 1
  let pos = open + 1
  while (pos < css.length && depth > 0) {
    if (css[pos] === "{") depth++
    else if (css[pos] === "}") depth--
    pos++
  }
  return css.slice(open + 1, pos - 1)
}

function extractRootBlock(css: string) {
  return extractBlock(css, /(?:^|\n):root\s*\{/)
}

function extractUtilityBlock(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return extractBlock(TAILWIND_CSS, new RegExp(`(?:^|\\n)@utility\\s+${escaped}\\s*\\{`))
}

function parseCustomProperties(block: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /--([a-z][a-z0-9-]*)\s*:\s*([\s\S]*?);/g
  let match: RegExpExecArray | null
  while ((match = re.exec(block)) !== null) {
    map.set(match[1], normalize(match[2]))
  }
  return map
}

function parseProperties(block: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /([a-z][a-z-]*)\s*:\s*([\s\S]*?);/g
  let match: RegExpExecArray | null
  while ((match = re.exec(block)) !== null) {
    map.set(match[1], normalize(match[2]))
  }
  return map
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function expectedProperties(role: Role): Map<string, string> {
  const properties = new Map<string, string>([
    ["font-family", `var(--font-family-${role.family})`],
    ["font-size", `var(--${role.size})`],
    ["font-weight", `var(--${role.weight})`],
    ["line-height", `var(--${role.lineHeight})`],
  ])
  if (role.letterSpacing) {
    properties.set("letter-spacing", `var(--${role.letterSpacing})`)
  }
  return properties
}

describe("#642 PR1: typography theme tokens", () => {
  const rootDecls = parseCustomProperties(extractRootBlock(THEME_CSS))

  for (const [token, value] of EXPECTED_VALUES) {
    test(`theme.css defines --${token}`, () => {
      expect(rootDecls.get(token)).toBe(value)
    })
  }
})

describe("#642 PR1: typography Tailwind utilities", () => {
  test("the @utility text-* role set is exact", () => {
    const actual = [
      ...TAILWIND_CSS.matchAll(/(?:^|\n)@utility\s+(text-[a-z0-9-]+)\s*\{/g),
    ].map((match) => match[1])
    expect(actual.sort()).toEqual(ROLES.map((role) => role.className).sort())
  })

  for (const role of ROLES) {
    test(`@utility ${role.className} references the matching role tokens`, () => {
      const actual = parseProperties(extractUtilityBlock(role.className))
      const expected = expectedProperties(role)

      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
      for (const [property, value] of expected) {
        expect(actual.get(property), `${role.className} ${property}`).toBe(value)
      }
    })
  }
})
