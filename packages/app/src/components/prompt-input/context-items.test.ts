import { describe, expect, test } from "bun:test"
import { isExternalChip } from "./path-canonical"

// isExternalChip is the pure helper that backs the external-chip guard in
// context-items.tsx and the defensive short-circuit in comment-routing.ts.
// Component-level rendering tests (aria-disabled attribute, click no-op) are
// deferred to T10 E2E because Bun's SolidJS harness requires non-trivial mock
// scaffolding; the logic tested here covers the decision boundary completely.

describe("isExternalChip", () => {
  test("relative path returns false (never external)", () => {
    expect(isExternalChip("src/foo.ts", "/workspace/project")).toBe(false)
  })

  test("absolute path under source directory returns false (internal)", () => {
    expect(isExternalChip("/workspace/project/src/foo.ts", "/workspace/project")).toBe(false)
  })

  test("absolute path that exactly matches source directory returns false (internal)", () => {
    expect(isExternalChip("/workspace/project", "/workspace/project")).toBe(false)
  })

  test("absolute path outside source directory returns true (external)", () => {
    expect(isExternalChip("/other/workspace/bar.ts", "/workspace/project")).toBe(true)
  })

  test("Windows drive path outside source returns true", () => {
    expect(isExternalChip("C:/Users/alice/other-project/file.ts", "D:/workspace/project")).toBe(true)
  })

  test("Windows drive path under same drive returns false when inside source", () => {
    expect(isExternalChip("C:/workspace/project/src/file.ts", "C:/workspace/project")).toBe(false)
  })

  test("UNC path is external from a POSIX root", () => {
    // UNC \\\\server\\share is absolute but not under /workspace
    expect(isExternalChip("\\\\server\\share\\file.ts", "/workspace/project")).toBe(true)
  })

  test("UNC forward-slash style is external from a POSIX root", () => {
    expect(isExternalChip("//server/share/file.ts", "/workspace/project")).toBe(true)
  })

  test("missing sourceFilesystemDirectory returns false (cannot determine externality)", () => {
    expect(isExternalChip("/absolute/path/file.ts", undefined)).toBe(false)
  })

  test("sibling directory with shared prefix is external", () => {
    // /workspace/project-B is NOT under /workspace/project-A
    expect(isExternalChip("/workspace/project-B/file.ts", "/workspace/project-A")).toBe(true)
  })
})
