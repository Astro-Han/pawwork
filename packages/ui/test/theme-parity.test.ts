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
// Non-color tokens are excluded from the broad prefix match. PR1 typography
// role properties are mirrored explicitly via TYPOGRAPHY_ROLE_TOKENS below.
const REGULATED_PREFIXES =
  /^(brand|bg|surface|fg|border|icon|success|warning|error|diff|shadow|ring|sidebar|code)/

// Tokens whose light value is intentionally identical in dark mode.
const SAME_IN_DARK = new Set(["brand-primary", "brand-primary-on", "fg-on-brand"])

const TYPOGRAPHY_ROLE_TOKENS = new Set([
  "font-size-display",
  "font-size-h1",
  "font-size-h2",
  "font-size-h3",
  "font-size-body",
  "font-size-caption",
  "font-size-mono",
  "font-size-mono-small",
  "font-size-kbd",
  "font-weight-display",
  "font-weight-h1",
  "font-weight-h2",
  "font-weight-h3",
  "font-weight-body",
  "font-weight-caption",
  "font-weight-emphasis",
  "font-weight-mono",
  "font-weight-mono-small",
  "font-weight-kbd",
  "line-height-display",
  "line-height-h1",
  "line-height-h2",
  "line-height-h3",
  "line-height-body",
  "line-height-caption",
  "line-height-mono",
  "line-height-mono-small",
  "line-height-kbd",
  "letter-spacing-display",
  "letter-spacing-h1",
  "letter-spacing-cjk",
])

function expectedOverrideKeys(regulatedKeys: Map<string, string>) {
  return new Set([...regulatedKeys.keys(), ...TYPOGRAPHY_ROLE_TOKENS])
}

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

  test("pawwork.json light.overrides keys exactly match regulated :root + typography set", () => {
    const jsonKeys = new Set(Object.keys(jsonLight))
    const expectedKeys = expectedOverrideKeys(cssLightRegulated)

    const extra = [...jsonKeys].filter((k) => !expectedKeys.has(k))
    expect(extra, `extra keys in light.overrides (not in theme.css :root): ${extra.join(", ")}`).toEqual([])

    const missing = [...expectedKeys].filter((k) => !jsonKeys.has(k))
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

  test("pawwork.json dark.overrides keys exactly match regulated dark + typography set", () => {
    const jsonKeys = new Set(Object.keys(jsonDark))
    const expectedKeys = expectedOverrideKeys(cssDarkRegulated)

    const extra = [...jsonKeys].filter((k) => !expectedKeys.has(k))
    expect(
      extra,
      `extra keys in dark.overrides (not in theme.css dark block or typography root set): ${extra.join(", ")}`,
    ).toEqual([])

    const missing = [...expectedKeys].filter((k) => !jsonKeys.has(k))
    expect(
      missing,
      `missing keys in dark.overrides (in theme.css dark block but not in pawwork.json): ${missing.join(", ")}`,
    ).toEqual([])
  })

  for (const [key, jsonValue] of Object.entries(jsonDark)) {
    test(`dark.overrides["${key}"] matches theme.css`, () => {
      const source = TYPOGRAPHY_ROLE_TOKENS.has(key) ? cssLight : cssDark
      const blockName = TYPOGRAPHY_ROLE_TOKENS.has(key) ? ":root" : "dark block"
      expect(source.has(key), `theme.css ${blockName} is missing --${key}`).toBe(true)
      expect(normalize(jsonValue)).toBe(normalize(source.get(key)!))
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

// ─── #642 PR0 invariants ────────────────────────────────────────────────────

// `code` is now inside REGULATED_PREFIXES (Step 2 of #642 plan Task 0.2), so
// light/dark parity for --code-surface is auto-covered by the existing
// exact-set test. The assertion below additionally pins the three theme-block
// values. `radius` remains outside REGULATED_PREFIXES (radii live in
// tailwind/@theme too, and the dual-namespace invariant is a separate
// dimension); the radii assertion below covers it directly.

const TAILWIND_CSS = readFileSync(
  join(ROOT, "src/styles/tailwind/index.css"),
  "utf-8",
)

describe("#642 PR0: radii dual-namespace", () => {
  test("radii are pixel-equal between theme.css :root and tailwind @theme", () => {
    const themeDecls = parseDeclarations(extractBlock(THEME_CSS, ":root"))
    const tailwindDecls = parseDeclarations(extractBlock(TAILWIND_CSS, "@theme"))
    const expected = { sm: "6px", md: "10px", lg: "14px" }
    for (const [name, value] of Object.entries(expected)) {
      expect(themeDecls.get(`radius-${name}`)).toBe(value)
      expect(tailwindDecls.get(`radius-${name}`)).toBe(value)
    }
  })
})

describe("#642 PR0: --code-surface three-block presence", () => {
  test("--code-surface is declared in all three theme blocks with expected values", () => {
    const lightDecls = parseDeclarations(extractBlock(THEME_CSS, ":root"))
    const darkDecls = parseDeclarations(
      extractBlock(THEME_CSS, ':root[data-color-scheme="dark"]'),
    )
    const mediaDecls = parseDeclarations(
      extractBlock(THEME_CSS, "@media (prefers-color-scheme: dark)"),
    )

    expect(normalize(lightDecls.get("code-surface") ?? "")).toBe(
      normalize("rgba(0, 0, 0, 0.04)"),
    )
    expect(normalize(darkDecls.get("code-surface") ?? "")).toBe(
      normalize("rgba(255, 255, 255, 0.06)"),
    )
    expect(normalize(mediaDecls.get("code-surface") ?? "")).toBe(
      normalize("rgba(255, 255, 255, 0.06)"),
    )
  })
})

describe("border tokens: unified hairline alpha across light and dark", () => {
  // Light and dark both resolve --border-* to alpha 0.08 (black on light,
  // white on dark). Drift between the two themes is unjustified at this
  // scale; locking the value prevents a silent rollback to the old 0.06
  // dark hairline that left sidebar↔thread with no visible boundary.
  test("--border-base / --border-weak / --border-weaker land on 0.08 in both themes", () => {
    const lightDecls = parseDeclarations(extractBlock(THEME_CSS, ":root"))
    const darkDecls = parseDeclarations(
      extractBlock(THEME_CSS, ':root[data-color-scheme="dark"]'),
    )
    const mediaDecls = parseDeclarations(
      extractBlock(THEME_CSS, "@media (prefers-color-scheme: dark)"),
    )

    for (const key of ["border-base", "border-weak", "border-weaker"]) {
      expect(normalize(lightDecls.get(key) ?? "")).toBe(normalize("rgba(0, 0, 0, 0.08)"))
      expect(normalize(darkDecls.get(key) ?? "")).toBe(normalize("rgba(255, 255, 255, 0.08)"))
      expect(normalize(mediaDecls.get(key) ?? "")).toBe(normalize("rgba(255, 255, 255, 0.08)"))
    }
  })
})

const MARKED_TSX = readFileSync(
  join(ROOT, "src/context/marked.tsx"),
  "utf-8",
)

describe("#642 PR0: shiki OpenCode theme background binds to --code-surface", () => {
  test("editor.background = var(--code-surface) (DESIGN.md L179)", () => {
    // Shiki single-theme codeToHtml inlines editor.background on
    // <pre class="shiki">, which beats any plain CSS rule on .shiki.
    // Binding the theme value itself is the only way fence-code blocks
    // actually render on the --code-surface alpha overlay.
    expect(MARKED_TSX).toMatch(/"editor\.background":\s*"var\(--code-surface\)"/)
  })
})

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
