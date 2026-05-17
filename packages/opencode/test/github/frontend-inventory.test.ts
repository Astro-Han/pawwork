import { describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.join(import.meta.dir, "../../../..")
const inventoryScript = path.join(repoRoot, "script", "frontend-inventory.mjs")

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function writeLines(filePath: string, count: number) {
  writeFileSync(
    filePath,
    Array.from({ length: count }, (_, index) => `export function value${index}() { return ${index} }`).join("\n") + "\n",
  )
}

describe("frontend inventory", () => {
  test("reports touched oversized production frontend files as warn-only baseline output", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "pawwork-frontend-inventory-"))
    cpSync(inventoryScript, path.join(workspace, "frontend-inventory.mjs"))
    mkdirSync(path.join(workspace, "packages", "app", "src"), { recursive: true })

    git(workspace, ["init"])
    git(workspace, ["config", "user.email", "codex@example.com"])
    git(workspace, ["config", "user.name", "Codex"])

    const largeFile = path.join(workspace, "packages", "app", "src", "large-view.ts")
    writeLines(largeFile, 205)
    git(workspace, ["add", "."])
    git(workspace, ["commit", "-m", "test: add baseline file"])
    const base = git(workspace, ["rev-parse", "HEAD"]).trim()

    writeLines(largeFile, 206)
    git(workspace, ["add", "."])
    git(workspace, ["commit", "-m", "test: modify large file"])
    const head = git(workspace, ["rev-parse", "HEAD"]).trim()

    const result = spawnSync("node", ["frontend-inventory.mjs", "--check-baseline", "--base", base, "--head", head], {
      cwd: workspace,
      encoding: "utf8",
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("Frontend LOC ratchet warnings")
    expect(result.stdout).toContain("warn-only")
    expect(result.stderr).toContain("::warning")
    expect(result.stderr).toContain("packages/app/src/large-view.ts")
    expect(result.stderr).toContain(">200 LOC")
  })
})
