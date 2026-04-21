import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../../", import.meta.url))

describe("Tauri cleanup", () => {
  test("does not keep the old Tauri data migration module", () => {
    expect(existsSync(join(packageRoot, "src/main/migrate.ts"))).toBe(false)
  })

  test("desktop README documents Electron commands, not Tauri commands", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8")

    expect(readme).toContain("bun run --cwd packages/desktop-electron dev")
    expect(readme).toContain("bun run --cwd packages/desktop-electron package")
    expect(readme).not.toMatch(/tauri/i)
    expect(readme).not.toMatch(/packages\/desktop\s+tauri/)
  })
})
