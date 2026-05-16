/**
 * undefined-tokens.test.ts
 *
 * Scans all CSS, TS, and TSX files under packages/ui/src and packages/app/src
 * for var(--xxx) references where --xxx starts with a STANDARDS-regulated prefix
 * (brand, bg, surface, fg, border, icon, success, warning, error, diff, shadow, ring, sidebar, code).
 *
 * Asserts that each such regulated token is either:
 *   1. Defined in theme.css (any block, including UNREGULATED section), OR
 *   2. Defined via @property in any scanned CSS file, OR
 *   3. In the known-gap allowlist below (pierre diff-viewer external API,
 *      Tailwind utility bridge tokens whose absence is intentional).
 *
 * Goal: catch accidentally dropped design tokens like --shadow-xxs-border,
 * without false-positives from third-party library variable APIs.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "fs"
import { join, extname } from "path"

const WORKTREE = join(import.meta.dirname, "..", "..", "..")
const THEME_CSS_PATH = join(WORKTREE, "packages/ui/src/styles/theme.css")

// Mirrors REGULATED_PREFIXES in theme-parity.test.ts
const REGULATED_PREFIXES =
  /^(brand|bg|surface|fg|border|icon|success|warning|error|diff|shadow|ring|sidebar|code)/

// Tokens that are legitimately absent from theme.css:
//   - pierre diff-viewer external API (--diffs-*): set by the pierre.js library
//     consumer; not ours to define in theme.css.
//   - --sidebar-width / --right-panel-width / --composer-dock-height:
//     @property registered lengths in index.css; their "value" is set by JS
//     and the @property block itself registers them (not a CSS variable assignment).
const ALLOWLIST_PREFIXES_EXTRA = [
  "--diffs-",         // pierre diff-viewer external API
]
const ALLOWLIST_EXACT_TOKENS = new Set([
  "sidebar-width",
  "right-panel-width",
  "composer-dock-height",
  "shell-titlebar-current-height",  // set by JS on the titlebar element
])

// ─── Extract all `--name:` definitions from a CSS source string ───────────────

function extractDefinedTokens(css: string): Set<string> {
  const tokens = new Set<string>()
  // CSS custom property assignment: --name:
  const re = /--([a-z][a-z0-9-]*)\s*:/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    tokens.add(m[1])
  }
  // @property --name { ... }
  const propRe = /@property\s+--([a-z][a-z0-9-]*)/g
  while ((m = propRe.exec(css)) !== null) {
    tokens.add(m[1])
  }
  return tokens
}

// ─── Recursively collect files with given extensions ─────────────────────────

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

// ─── Extract var(--xxx) references for regulated tokens only ─────────────────

function extractRegulatedVarRefs(source: string): string[] {
  const refs: string[] = []
  const re = /var\(\s*--([a-z][a-z0-9-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const name = m[1]
    if (REGULATED_PREFIXES.test(name)) {
      refs.push(name)
    }
  }
  return refs
}

// ─── Build data ───────────────────────────────────────────────────────────────

// All tokens defined in theme.css (all blocks, including UNREGULATED)
const themeCss = readFileSync(THEME_CSS_PATH, "utf-8")
const definedInTheme = extractDefinedTokens(themeCss)

// Also collect @property definitions from all CSS files in packages/app/src
const appSrcDir = join(WORKTREE, "packages/app/src")
const allDefinedViaProperty = new Set<string>()
for (const file of collectFiles(appSrcDir, [".css"])) {
  let source: string
  try {
    source = readFileSync(file, "utf-8")
  } catch {
    continue
  }
  for (const token of extractDefinedTokens(source)) {
    allDefinedViaProperty.add(token)
  }
}

const scanDirs = [
  join(WORKTREE, "packages/ui/src"),
  appSrcDir,
]
const extensions = [".css", ".ts", ".tsx"]

// Map: regulated token name → list of files referencing it
const usageMap = new Map<string, string[]>()

for (const dir of scanDirs) {
  for (const file of collectFiles(dir, extensions)) {
    let source: string
    try {
      source = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    for (const token of extractRegulatedVarRefs(source)) {
      if (!usageMap.has(token)) usageMap.set(token, [])
      usageMap.get(token)!.push(file.replace(WORKTREE + "/", ""))
    }
  }
}

// ─── Helper: is token covered? ───────────────────────────────────────────────

function isCovered(token: string): boolean {
  // Defined in theme.css (all blocks)
  if (definedInTheme.has(token)) return true
  // Defined via @property or CSS assignment in packages/app/src
  if (allDefinedViaProperty.has(token)) return true
  // Exact allowlist
  if (ALLOWLIST_EXACT_TOKENS.has(token)) return true
  // Prefix allowlist (pierre diffs, Tailwind bridge shadows)
  if (ALLOWLIST_PREFIXES_EXTRA.some((p) => `--${token}`.startsWith(p))) return true
  return false
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("undefined-tokens: regulated var() references resolve to theme.css", () => {
  test("theme.css defines tokens (sanity check)", () => {
    expect(definedInTheme.size).toBeGreaterThan(20)
  })

  test("no regulated var(--xxx) references a token absent from theme.css", () => {
    const missing: { token: string; files: string[] }[] = []

    for (const [token, files] of usageMap) {
      if (!isCovered(token)) {
        missing.push({ token, files: [...new Set(files)].slice(0, 3) })
      }
    }

    if (missing.length > 0) {
      const report = missing
        .map(({ token, files }) => `  --${token}  (used in: ${files.join(", ")})`)
        .join("\n")
      expect(
        missing.length,
        `Found ${missing.length} regulated token(s) used via var() but not defined in theme.css:\n${report}`,
      ).toBe(0)
    }
  })
})
