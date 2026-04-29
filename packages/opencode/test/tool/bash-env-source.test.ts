import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

test("Bash tool disables OfficeCLI self-update for bundled tools", () => {
  const source = readFileSync(path.join(import.meta.dir, "../../src/tool/bash.ts"), "utf8")
  expect(source).toContain("OFFICECLI_SKIP_UPDATE")
  expect(source).toContain('OFFICECLI_SKIP_UPDATE: "1"')
})
