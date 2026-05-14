/**
 * dark-media-guard.test.ts
 *
 * Enforces the project rule that every `@media (prefers-color-scheme: dark)`
 * block must be guarded by `:root:not([data-color-scheme="light"])`.
 *
 * Without the guard, when the OS prefers dark but the user has explicitly
 * set PawWork to Light via the settings (data-color-scheme="light"), the
 * dark media block still fires and reads light-theme tokens at dark-theme
 * call sites — producing visibly broken bubbles, switches, code opacity,
 * etc. The mirror pattern matches theme.css's own dark @media block
 * (search "first-paint mirror" in theme.css for the rationale).
 *
 * Scope: static UI CSS files under `packages/ui/src/components/` and
 * `packages/ui/src/styles/`. These are the files that actually ship
 * to the runtime — the live theme application path runs through
 * `theme/context.tsx`'s `applyThemeCss`, which emits CSS per-mode
 * without `@media` at all.
 *
 * `theme/loader.ts` also contains a `buildThemeCss` template literal
 * with unguarded `@media (prefers-color-scheme: dark)` blocks, but it
 * is dead code in PawWork: no callsite imports it, and
 * `desktop-electron/src/renderer/theme-context.test.ts` actively
 * enforces that the renderer uses `theme/context` rather than the
 * `theme/` barrel that re-exports loader. Not in scope here.
 *
 * Comment-only matches (e.g. doc strings explaining the convention)
 * are tolerated; we only check `@media` blocks that actually open a rule.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"

const ROOT = join(import.meta.dirname, "..")
const SCAN_DIRS = ["src/components", "src/styles"]
const GUARD = ':root:not([data-color-scheme="light"])'

type Hit = { file: string; line: number; nextSelector: string }

function listCssFiles(dir: string): string[] {
  const out: string[] = []
  const entries = readdirSync(dir)
  for (const name of entries) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listCssFiles(full))
    } else if (name.endsWith(".css")) {
      out.push(full)
    }
  }
  return out
}

function findUnguarded(): Hit[] {
  const hits: Hit[] = []
  for (const sub of SCAN_DIRS) {
    const files = listCssFiles(join(ROOT, sub))
    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Skip lines that are entirely inside a comment marker.
        const trimmed = line.trim()
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue
        if (!/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/.test(line)) continue
        // Look ahead for the first non-empty, non-comment line — that's the inner selector.
        let next = ""
        let nextIdx = i + 1
        for (; nextIdx < lines.length; nextIdx++) {
          const t = lines[nextIdx].trim()
          if (!t) continue
          if (t.startsWith("/*") || t.startsWith("*") || t.startsWith("//")) continue
          next = t
          break
        }
        if (!next.startsWith(GUARD)) {
          hits.push({ file: relative(ROOT, file), line: i + 1, nextSelector: next })
        }
      }
    }
  }
  return hits
}

describe("dark-media-guard", () => {
  test("every @media (prefers-color-scheme: dark) is guarded by :root:not([data-color-scheme=\"light\"])", () => {
    const hits = findUnguarded()
    if (hits.length > 0) {
      const detail = hits
        .map((h) => `  ${h.file}:${h.line}\n    inner selector: ${h.nextSelector}`)
        .join("\n")
      throw new Error(
        `Found ${hits.length} unguarded \`@media (prefers-color-scheme: dark)\` block(s).\n` +
          `Each block must wrap its rules in \`${GUARD}\` so that explicit Light theme + OS dark\n` +
          `does not incorrectly trigger the dark-mode branch.\n\n` +
          `Violations:\n${detail}\n`,
      )
    }
    expect(hits).toEqual([])
  })
})
