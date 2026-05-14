import { test, expect } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"

const APP_SRC = __dirname
// packages/app/src → up 2 to packages → into ui/src/components
const UI_COMPONENTS = path.resolve(__dirname, "..", "..", "ui", "src", "components")

// Allowlist: legitimate references to mode === "primary" outside the picker context.
// Each entry: { file: relative-to-APP_SRC, line: 1-based, reason: short justification }.
// Add entries here only when you have read the line and confirmed it is not picker-related.
const MODE_PRIMARY_ALLOWLIST: { file: string; line: number; reason: string }[] = [
  {
    file: "context/global-sync/utils.ts",
    line: 15,
    reason: "type guard isAgent: validates agent shape, accepts any of subagent|primary|all (not picker logic)",
  },
]

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      await walk(full, acc)
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

test("i18n bundles contain no primary-agent / mode-picker copy", async () => {
  const zh = await fs.readFile(path.join(APP_SRC, "i18n", "zh.ts"), "utf8")
  const en = await fs.readFile(path.join(APP_SRC, "i18n", "en.ts"), "utf8")
  const re = /primary agent|default agent|agent mode|mode picker/i
  expect(zh).not.toMatch(re)
  expect(en).not.toMatch(re)
})

test('no source file in packages/app/src uses mode === "primary" outside the allowlist', async () => {
  const files = await walk(APP_SRC)
  const re = /mode\s*[!=]==?\s*['"]primary['"]/
  const offenders: { file: string; line: number; text: string }[] = []
  for (const file of files) {
    const text = await fs.readFile(file, "utf8")
    const lines = text.split(/\r?\n/)
    lines.forEach((lineText, i) => {
      if (!re.test(lineText)) return
      // Normalize to forward slashes so the Windows backslash form of
      // `path.relative` still matches MODE_PRIMARY_ALLOWLIST entries authored
      // with POSIX-style paths.
      const relPath = path.relative(APP_SRC, file).replaceAll(path.sep, "/")
      const ok = MODE_PRIMARY_ALLOWLIST.some((a) => a.file === relPath && a.line === i + 1)
      if (!ok) offenders.push({ file: relPath, line: i + 1, text: lineText.trim() })
    })
  }
  if (offenders.length > 0) {
    const summary = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n")
    throw new Error(
      `Found ${offenders.length} mode === "primary" reference(s) in packages/app/src not in MODE_PRIMARY_ALLOWLIST:\n${summary}\n\nIf the reference is legitimate (not picker-related), add it to MODE_PRIMARY_ALLOWLIST in this test file with a one-line reason.`,
    )
  }
})

test("agentList memo is gone from prompt-input.tsx", async () => {
  const file = path.join(APP_SRC, "components", "prompt-input.tsx")
  const text = await fs.readFile(file, "utf8")
  expect(text).not.toContain("agentList")
})

test("message-part.tsx no longer renders agent pill", async () => {
  // After Task 5, HighlightedText drops agents from allRefs and the type union no
  // longer includes "agent". Source-grep guards against future regressions that
  // re-introduce a styled pill via the same data-highlight marker.
  const root = path.join(UI_COMPONENTS, "message-part")
  const files = [path.join(UI_COMPONENTS, "message-part.tsx"), ...(await walk(root))]
  const text = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n")
  // Match data-highlight="agent" / 'agent' / `agent` to survive quote-style changes.
  expect(text).not.toMatch(/data-highlight\s*=\s*["'`]agent["'`]/)
})
