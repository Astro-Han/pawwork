import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const source = readFileSync(join(import.meta.dir, "index.tsx"), "utf8")

test("renderer uses the direct theme context import for useTheme", () => {
  expect(source).toContain('import { useTheme } from "@opencode-ai/ui/theme/context"')
  expect(source).not.toContain('import { useTheme } from "@opencode-ai/ui/theme"')
})
