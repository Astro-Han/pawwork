/**
 * theme-parity.test.ts
 *
 * Enforces sync between theme.css (runtime source of truth) and
 * pawwork.json (JSON mirror for the opencode loader contract).
 *
 * Passes if and only if:
 *   - Every key in pawwork.json light.overrides exists in theme.css :root with matching value
 *   - Every key in pawwork.json dark.overrides exists in theme.css dark block with matching value
 *   - No key in either overrides block is absent from the corresponding theme.css block
 *   - The two files agree on a common "regulated color" set
 *     (tokens whose names start with a STANDARDS-aligned prefix)
 *
 * Value normalization before comparison:
 *   - Collapse whitespace (multi-line → single space)
 *   - Lowercase hex digits (#FF5910 → #ff5910)
 *   - Normalize rgba() argument spacing (rgba(0, 0, 0, 0.1))
 *   - Remove units from zero values (0px → 0)
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const THEME_CSS = readFileSync(join(ROOT, "src/styles/theme.css"), "utf-8")
const PAWWORK_JSON = JSON.parse(
  readFileSync(join(ROOT, "src/theme/themes/pawwork.json"), "utf-8"),
)

// Token name prefixes that belong to the STANDARDS-regulated color set.
// Non-color tokens (font-*, space-*, radius-*, type-*, duration-*, letter-*,
// line-height-*, --color-scheme) are excluded from parity checks.
const REGULATED_PREFIXES =
  /^(brand|bg|surface|fg|border|icon|success|warning|error|diff|shadow|ring|sidebar)/

// Tokens whose light value is intentionally identical in dark mode.
const SAME_IN_DARK = new Set(["brand-primary", "brand-primary-on", "fg-on-brand"])

// ─── CSS parsing helpers ────────────────────────────────────────────────────

/**
 * Extract the raw block content (between braces) for a given CSS selector.
 * `selector` must NOT include the opening brace.
 * Requires the selector to be at a line start (or file start) to skip
 * occurrences embedded inside comments.
 */
function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // Match selector at line-start, followed by optional whitespace then {
  const pattern = new RegExp(`(?:^|\n)${escaped}\\s*\\{`)
  const m = pattern.exec(css)
  if (!m) return ""
  const open = m.index + m[0].lastIndexOf("{")
  let depth = 1
  let pos = open + 1
  while (pos < css.length && depth > 0) {
    if (css[pos] === "{") depth++
    else if (css[pos] === "}") depth--
    pos++
  }
  return css.slice(open + 1, pos - 1)
}

/** Trim block content at a comment containing `marker`. */
function trimAtComment(block: string, marker: string): string {
  const idx = block.indexOf(marker)
  if (idx === -1) return block
  const commentStart = block.lastIndexOf("/*", idx)
  return commentStart === -1 ? block : block.slice(0, commentStart)
}

/**
 * Parse all `--name: value;` custom property declarations from a CSS block.
 * Multi-line values (e.g., shadows) are collapsed to a single string.
 */
function parseDeclarations(block: string): Map<string, string> {
  const map = new Map<string, string>()
  // Match --name followed by : then anything up to ; (non-greedy, handles newlines)
  const re = /--([a-z][a-z0-9-]*)\s*:\s*([\s\S]*?);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    map.set(m[1], m[2].trim())
  }
  return map
}

/** Normalize a CSS value for comparison. */
function normalize(value: string): string {
  // 1. Collapse whitespace
  let v = value.replace(/\s+/g, " ").trim()
  // 2. Lowercase hex colors
  v = v.replace(/#[0-9A-Fa-f]+/g, (h) => h.toLowerCase())
  // 3. Normalize rgba?() argument spacing: rgba(0 , 0,0,.1) → rgba(0, 0, 0, 0.1)
  v = v.replace(/\b(rgba?)\(([^)]+)\)/g, (_full, fn, args) => {
    const norm = args
      .split(",")
      .map((a: string) => a.trim())
      .join(", ")
    return `${fn}(${norm})`
  })
  // 4. Remove units from zero
  v = v.replace(/\b0(px|em|rem|%|pt|vw|vh)\b/g, "0")
  return v
}

// ─── Parse theme.css ────────────────────────────────────────────────────────

const rawLightBlock = trimAtComment(
  extractBlock(THEME_CSS, ":root"),
  "UNREGULATED TOKENS",
)
const rawDarkBlock = trimAtComment(
  extractBlock(THEME_CSS, ':root[data-color-scheme="dark"]'),
  "Unregulated dark mirror",
)

const cssLight = parseDeclarations(rawLightBlock)
const cssDark = parseDeclarations(rawDarkBlock)

// Regulated subsets: only tokens matching STANDARDS prefixes
const cssLightRegulated = new Map(
  [...cssLight].filter(([k]) => REGULATED_PREFIXES.test(k)),
)
const cssDarkRegulated = new Map(
  [...cssDark].filter(([k]) => REGULATED_PREFIXES.test(k)),
)

// ─── @media mirror block ─────────────────────────────────────────────────────
const rawMediaBlock = trimAtComment(
  extractBlock(THEME_CSS, "@media (prefers-color-scheme: dark)"),
  "Unregulated dark mirror",
)
const cssMediaDark = parseDeclarations(rawMediaBlock)
const cssMediaDarkRegulated = new Map(
  [...cssMediaDark].filter(([k]) => REGULATED_PREFIXES.test(k)),
)

// ─── pawwork.json overrides ─────────────────────────────────────────────────

const jsonLight: Record<string, string> = PAWWORK_JSON.light.overrides
const jsonDark: Record<string, string> = PAWWORK_JSON.dark.overrides

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("theme-parity: light overrides ↔ theme.css :root", () => {
  test("theme.css :root has a non-empty regulated set", () => {
    expect(cssLightRegulated.size).toBeGreaterThan(10)
  })

  test("pawwork.json light.overrides keys exactly match regulated :root set", () => {
    const jsonKeys = new Set(Object.keys(jsonLight))
    const cssKeys = cssLightRegulated

    const extra = [...jsonKeys].filter((k) => !cssKeys.has(k))
    expect(extra, `extra keys in light.overrides (not in theme.css :root): ${extra.join(", ")}`).toEqual([])

    const missing = [...cssKeys.keys()].filter((k) => !jsonKeys.has(k))
    expect(
      missing,
      `missing keys in light.overrides (in theme.css :root but not in pawwork.json): ${missing.join(", ")}`,
    ).toEqual([])
  })

  for (const [key, jsonValue] of Object.entries(jsonLight)) {
    test(`light.overrides["${key}"] matches theme.css`, () => {
      expect(cssLight.has(key), `theme.css :root is missing --${key}`).toBe(true)
      expect(normalize(jsonValue)).toBe(normalize(cssLight.get(key)!))
    })
  }
})

describe("theme-parity: dark overrides ↔ theme.css [data-color-scheme='dark']", () => {
  test("theme.css dark block has a non-empty regulated set", () => {
    expect(cssDarkRegulated.size).toBeGreaterThan(10)
  })

  test("pawwork.json dark.overrides keys exactly match regulated dark block set", () => {
    const jsonKeys = new Set(Object.keys(jsonDark))
    const cssKeys = cssDarkRegulated

    const extra = [...jsonKeys].filter((k) => !cssKeys.has(k))
    expect(extra, `extra keys in dark.overrides (not in theme.css dark block): ${extra.join(", ")}`).toEqual([])

    const missing = [...cssKeys.keys()].filter((k) => !jsonKeys.has(k))
    expect(
      missing,
      `missing keys in dark.overrides (in theme.css dark block but not in pawwork.json): ${missing.join(", ")}`,
    ).toEqual([])
  })

  for (const [key, jsonValue] of Object.entries(jsonDark)) {
    test(`dark.overrides["${key}"] matches theme.css`, () => {
      expect(cssDark.has(key), `theme.css dark block is missing --${key}`).toBe(true)
      expect(normalize(jsonValue)).toBe(normalize(cssDark.get(key)!))
    })
  }
})

describe("theme-parity: dark completeness", () => {
  test("all light regulated tokens have a dark override or are in SAME_IN_DARK", () => {
    const missing = [...cssLightRegulated.keys()].filter(
      (k) => !cssDarkRegulated.has(k) && !SAME_IN_DARK.has(k),
    )
    expect(
      missing,
      `light regulated tokens with no dark override (add to dark block or SAME_IN_DARK): ${missing.join(", ")}`,
    ).toEqual([])
  })
})

describe("theme-parity: @media mirror ↔ [data-color-scheme='dark']", () => {
  test("@media dark mirror has a non-empty regulated set", () => {
    expect(cssMediaDarkRegulated.size).toBeGreaterThan(10)
  })

  test("@media mirror regulated tokens exactly match attribute dark block", () => {
    const attrKeys = new Set(cssDarkRegulated.keys())
    const mediaKeys = new Set(cssMediaDarkRegulated.keys())

    const onlyInAttr = [...attrKeys].filter((k) => !mediaKeys.has(k))
    expect(
      onlyInAttr,
      `tokens in [data-color-scheme="dark"] but missing from @media mirror: ${onlyInAttr.join(", ")}`,
    ).toEqual([])

    const onlyInMedia = [...mediaKeys].filter((k) => !attrKeys.has(k))
    expect(
      onlyInMedia,
      `tokens in @media mirror but missing from [data-color-scheme="dark"]: ${onlyInMedia.join(", ")}`,
    ).toEqual([])
  })

  for (const [key, attrValue] of cssDarkRegulated) {
    test(`@media mirror["${key}"] matches [data-color-scheme="dark"] block`, () => {
      expect(cssMediaDarkRegulated.has(key), `@media mirror is missing --${key}`).toBe(true)
      expect(normalize(cssMediaDarkRegulated.get(key)!)).toBe(normalize(attrValue))
    })
  }
})

// ─── Runtime-critical non-regulated tokens ──────────────────────────────────

describe("theme-parity: runtime-critical non-regulated tokens", () => {
  test("dark attribute block has --text-mix-blend-mode: plus-lighter", () => {
    expect(cssDark.has("text-mix-blend-mode"), "--text-mix-blend-mode missing from dark attribute block").toBe(true)
    expect(normalize(cssDark.get("text-mix-blend-mode")!)).toBe("plus-lighter")
  })

  test("@media mirror has --text-mix-blend-mode: plus-lighter", () => {
    expect(cssMediaDark.has("text-mix-blend-mode"), "--text-mix-blend-mode missing from @media mirror").toBe(true)
    expect(normalize(cssMediaDark.get("text-mix-blend-mode")!)).toBe("plus-lighter")
  })
})

// ─── Parser unit fixtures ────────────────────────────────────────────────────

describe("theme-parser: extractBlock fixtures", () => {
  test("extracts a top-level selector block", () => {
    const css = `:root {\n  --color: red;\n}\n`
    expect(extractBlock(css, ":root")).toContain("--color: red;")
  })

  test("ignores selector occurrence inside a comment", () => {
    const css = `/* :root { --commented: yes; } */\n:root {\n  --real: blue;\n}\n`
    const block = extractBlock(css, ":root")
    expect(block).not.toContain("--commented")
    expect(block).toContain("--real")
  })

  test("handles nested braces (e.g. @media inside a block)", () => {
    const css = `:root {\n  --a: 1px;\n  @media (min-width: 100px) { --b: 2px; }\n  --c: 3px;\n}\n`
    const block = extractBlock(css, ":root")
    expect(block).toContain("--a: 1px;")
    expect(block).toContain("--c: 3px;")
  })

  test("returns empty string when selector is absent", () => {
    expect(extractBlock(":root { --x: 1px; }", ".nonexistent")).toBe("")
  })
})

describe("theme-parser: parseDeclarations fixtures", () => {
  test("parses single-line declarations", () => {
    const map = parseDeclarations("  --color: red;\n  --size: 12px;\n")
    expect(map.get("color")).toBe("red")
    expect(map.get("size")).toBe("12px")
  })

  test("multi-line shadow value: raw preserves structure, normalize collapses whitespace", () => {
    const css = `  --shadow-xl:\n    0 0 0 1px black,\n    0 4px 8px rgba(0, 0, 0, 0.1);\n`
    const map = parseDeclarations(css)
    const v = map.get("shadow-xl")
    expect(v).toBeTruthy()
    // normalize() collapses newlines/indentation to single spaces
    expect(normalize(v!)).toBe("0 0 0 1px black, 0 4px 8px rgba(0, 0, 0, 0.1)")
  })

  test("last definition wins for duplicate token names", () => {
    const map = parseDeclarations("  --x: first;\n  --x: second;\n")
    expect(map.get("x")).toBe("second")
  })
})

describe("theme-parser: normalize fixtures", () => {
  test("lowercases hex digits", () => {
    expect(normalize("#FF5910")).toBe("#ff5910")
    expect(normalize("#FFFFFF")).toBe("#ffffff")
  })

  test("removes units from zero values", () => {
    expect(normalize("0px")).toBe("0")
    expect(normalize("0 0 0 1px")).toBe("0 0 0 1px")
  })

  test("normalizes rgba argument spacing", () => {
    expect(normalize("rgba(0,0,0,.1)")).toBe("rgba(0, 0, 0, .1)")
    expect(normalize("rgba( 255 , 89 , 16 , 0.2 )")).toBe("rgba(255, 89, 16, 0.2)")
  })

  test("collapses internal whitespace", () => {
    expect(normalize("0  0  0  1px  red")).toBe("0 0 0 1px red")
  })
})
