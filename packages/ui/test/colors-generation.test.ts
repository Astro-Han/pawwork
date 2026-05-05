/**
 * colors-generation.test.ts
 *
 * Verifies that tailwind/colors.css is in sync with script/colors.txt.
 * For every --X token defined in colors.txt there must be a corresponding
 * --color-X: var(--X) entry in colors.css, and vice versa (no orphan entries).
 *
 * This catches stale artifacts: if colors.txt is updated but colors.css is not
 * regenerated, a Tailwind utility like `bg-surface-base-active` would silently
 * resolve to the wrong value.
 */

import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dirname, "..")
const COLORS_TXT = readFileSync(join(ROOT, "script/colors.txt"), "utf-8")
const COLORS_CSS = readFileSync(join(ROOT, "src/styles/tailwind/colors.css"), "utf-8")

/** Extract token names from colors.txt (e.g. "--brand-primary: ..." → "brand-primary") */
function parseTxtTokens(txt: string): string[] {
  return txt
    .split("\n")
    .filter((l) => l.trim().startsWith("--"))
    .map((l) => l.trim().split(":")[0].trim().substring(2))
    .filter(Boolean)
}

/** Extract token names from colors.css @theme block (e.g. "--color-brand-primary: var(--brand-primary)" → "brand-primary") */
function parseCssTokens(css: string): string[] {
  const entries: string[] = []
  const re = /--color-([^\s:]+)\s*:\s*var\(--\1\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    entries.push(m[1])
  }
  return entries
}

const txtTokens = parseTxtTokens(COLORS_TXT)
const cssTokens = parseCssTokens(COLORS_CSS)

test("colors.txt has no duplicate token names", () => {
  const dupes = txtTokens.filter((t, i) => txtTokens.indexOf(t) !== i)
  expect(dupes, `duplicate tokens in colors.txt: ${dupes.join(", ")}`).toEqual([])
})

test("colors.css has no duplicate token entries", () => {
  const dupes = cssTokens.filter((t, i) => cssTokens.indexOf(t) !== i)
  expect(dupes, `duplicate entries in colors.css: ${dupes.join(", ")}`).toEqual([])
})

test("every colors.txt token has a --color-X: var(--X) entry in colors.css", () => {
  const cssSet = new Set(cssTokens)
  const missing = txtTokens.filter((t) => !cssSet.has(t))
  expect(
    missing,
    `tokens in colors.txt missing from colors.css: ${missing.join(", ")}`,
  ).toEqual([])
})

test("every colors.css entry has a corresponding token in colors.txt", () => {
  const txtSet = new Set(txtTokens)
  const orphan = cssTokens.filter((t) => !txtSet.has(t))
  expect(
    orphan,
    `tokens in colors.css not present in colors.txt: ${orphan.join(", ")}`,
  ).toEqual([])
})
