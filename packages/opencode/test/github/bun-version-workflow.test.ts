import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const workflowsRoot = path.join(repoRoot, ".github", "workflows")
const expectedBunVersion = "1.3.14"
const auditComment = "Load-bearing for `bun audit` exit semantics"

describe("GitHub workflow Bun version pin", () => {
  test("keeps every setup-bun runtime on the audit-verified Bun version", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      packageManager?: string
    }
    expect(packageJson.packageManager).toBe(`bun@${expectedBunVersion}`)

    const workflowFiles = fs
      .readdirSync(workflowsRoot)
      .filter((name) => name.endsWith(".yml"))
      .sort()
      .map((name) => path.join(workflowsRoot, name))

    const setupBunPins: string[] = []
    const missingComments: string[] = []

    for (const workflowPath of workflowFiles) {
      const lines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if (!line.includes("bun-version:")) continue

        const relativePath = path.relative(repoRoot, workflowPath)
        setupBunPins.push(`${relativePath}:${index + 1}:${line.trim()}`)
        const previousLines = lines.slice(Math.max(0, index - 3), index).join("\n")
        if (!previousLines.includes(auditComment)) {
          missingComments.push(`${relativePath}:${index + 1}`)
        }
      }
    }

    expect(setupBunPins.map((entry) => entry.replace(/:\d+:/, ":line:"))).toEqual([
      ".github/workflows/build.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/ci.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/desktop-smoke.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/dev-dep-audit.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/e2e-artifacts.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/officecli-bump.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/perf-probe-baseline.yml:line:bun-version: \"1.3.14\"",
      ".github/workflows/windows-advisory.yml:line:bun-version: \"1.3.14\"",
    ])
    expect(missingComments).toEqual([])
  })
})
