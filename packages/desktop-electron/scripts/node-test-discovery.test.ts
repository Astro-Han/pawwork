import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("Node-only test discovery", () => {
  test("keeps node:sqlite suites out of Bun discovery and runs them explicitly", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
    const nodeTestFiles = [
      "resources/dsh/home/plugins/import-v1/import-v1.node-test.cjs",
      "resources/dsh/home/plugins/import-v1/import-v1-automations.node-test.cjs",
    ]

    for (const relativePath of nodeTestFiles) {
      expect(readFileSync(join(packageRoot, relativePath), "utf8")).toContain("node:sqlite")
      expect(relativePath).not.toMatch(/\.test\.[cm]?[jt]s$/)
    }
    expect(packageJson.scripts["test:node"]).toBe(`node --test ${nodeTestFiles.join(" ")}`)
    expect(packageJson.scripts.test).toContain("bun run test:node")
    expect(packageJson.scripts["test:ci"]).toContain("bun run test:node")
  })
})
