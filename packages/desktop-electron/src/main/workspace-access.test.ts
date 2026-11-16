import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { canonicalWorkspaceDirectory, hasApprovedWorkspace, lastApprovedWorkspace, rememberWorkspace } from "./workspace-access"

test("remembers approved folders and restores only an accessible last folder", () => {
  const root = mkdtempSync(join(tmpdir(), "pawwork-access-"))
  const first = mkdtempSync(join(root, "first-"))
  const second = mkdtempSync(join(root, "second-"))
  const state = join(root, "userData", "workspace-access.json")
  try {
    const firstPath = canonicalWorkspaceDirectory(first)!
    const secondPath = canonicalWorkspaceDirectory(second)!
    expect(lastApprovedWorkspace(state)).toBeUndefined()
    rememberWorkspace(state, firstPath)
    expect(hasApprovedWorkspace(state, firstPath)).toBe(true)
    expect(hasApprovedWorkspace(state, secondPath)).toBe(false)
    rememberWorkspace(state, secondPath)
    expect(lastApprovedWorkspace(state)).toBe(secondPath)
    expect(JSON.parse(readFileSync(state, "utf8")).approved).toEqual([firstPath, secondPath])
    rmSync(second, { recursive: true })
    expect(lastApprovedWorkspace(state)).toBeUndefined()
    expect(hasApprovedWorkspace(state, firstPath)).toBe(true)
    writeFileSync(state, "invalid JSON")
    expect(hasApprovedWorkspace(state, firstPath)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
