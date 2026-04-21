import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.join(import.meta.dir, "../../../..")

type PackageJson = {
  workspaces?: {
    catalog?: Record<string, string>
  }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

async function readJson(file: string) {
  return (await Bun.file(file).json()) as PackageJson
}

describe("workspace catalog", () => {
  test("provides root catalog entries for plugin catalog dependencies", async () => {
    const root = await readJson(path.join(repoRoot, "package.json"))
    const plugin = await readJson(path.join(repoRoot, "packages/plugin/package.json"))

    const catalog = root.workspaces?.catalog ?? {}
    const refs = {
      ...(plugin.dependencies ?? {}),
      ...(plugin.devDependencies ?? {}),
    }

    const missing = Object.entries(refs)
      .filter(([, version]) => version === "catalog:")
      .map(([name]) => name)
      .filter((name) => !(name in catalog))

    expect(missing).toEqual([])
  })
})
