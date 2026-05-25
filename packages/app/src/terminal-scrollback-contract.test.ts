import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * Regression guard for the ghostty-web WASM ring-buffer corruption workaround.
 *
 * packages/app/src/components/terminal.tsx pins `scrollback` to a very large
 * value (10_000_000) to dodge a known ghostty-web bug where small scrollback
 * limits cause garbage Hangul characters, wide CJK spacing, and mid-word wraps
 * once enough output accumulates. Upstream documents the bug in their own
 * regression test (anomalyco/ghostty-web lib/viewport-row-merge.test.ts) but
 * has not landed a fix.
 *
 * This test fails if anyone lowers the value back into the broken range. If
 * you're seeing this fail intentionally, read the comment in terminal.tsx
 * first — the value can only be reduced once upstream ships a patched WASM.
 */

const SAFE_MIN_SCROLLBACK = 1_000_000

test("terminal.tsx pins ghostty-web scrollback above the ring-buffer corruption threshold", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "components/terminal.tsx"), "utf8")
  const match = source.match(/scrollback:\s*([\d_]+)/)
  expect(match, "could not locate `scrollback: <N>` in components/terminal.tsx").not.toBeNull()
  const value = Number(match![1].replaceAll("_", ""))
  expect(
    value,
    `scrollback was lowered to ${value}; ghostty-web ring buffer corrupts at small values — see comment in components/terminal.tsx`,
  ).toBeGreaterThanOrEqual(SAFE_MIN_SCROLLBACK)
})
