import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const bunModulesRoot = path.join(repoRoot, "node_modules", ".bun")

test("every minimatch release uses the patched brace-expansion without breaking brace globs", () => {
  const minimatchInstalls = readdirSync(bunModulesRoot)
    .filter((entry) => entry.startsWith("minimatch@"))
    .sort()

  expect(minimatchInstalls.length).toBeGreaterThan(0)

  for (const install of minimatchInstalls) {
    const minimatchPackage = path.join(bunModulesRoot, install, "node_modules", "minimatch", "package.json")
    const requireFromMinimatch = createRequire(minimatchPackage)
    const braceExpansionPackage = requireFromMinimatch("brace-expansion/package.json") as { version: string }
    const minimatch = requireFromMinimatch("minimatch") as {
      braceExpand: (pattern: string) => string[]
    }

    expect(braceExpansionPackage.version).toBe("5.0.9")
    expect(minimatch.braceExpand("file-{a,b}.txt")).toEqual(["file-a.txt", "file-b.txt"])
  }
})
