import { describe, expect, test } from "bun:test"
import { countUniqueImporters, isUiSourceFile, shouldForceFullReloadForUiHmr } from "./vite.hmr.js"

function module(importers: any[] = []) {
  return { importers: new Set(importers) }
}

describe("vite ui hmr guard", () => {
  test("only targets packages/ui source files", () => {
    expect(isUiSourceFile("/repo/packages/ui/src/components/icon.tsx")).toBe(true)
    expect(isUiSourceFile("C:\\repo\\packages\\ui\\src\\components\\icon.tsx")).toBe(true)
    expect(isUiSourceFile("/repo/packages/app/src/app.tsx")).toBe(false)
  })

  test("counts unique importers across a transitive graph", () => {
    const leaf = module()
    const a = module()
    const b = module()
    const c = module()
    leaf.importers = new Set([a, b])
    a.importers = new Set([c])
    b.importers = new Set([c])

    expect(countUniqueImporters([leaf])).toBe(3)
  })

  test("forces a full reload for high-fanout ui modules", () => {
    const leaf = module()
    const importers = Array.from({ length: 31 }, () => module())
    leaf.importers = new Set(importers)

    expect(
      shouldForceFullReloadForUiHmr({
        file: "/repo/packages/ui/src/components/icon.tsx",
        modules: [leaf],
      }),
    ).toBe(true)
  })

  test("keeps normal hmr for low-fanout ui modules", () => {
    const leaf = module()
    leaf.importers = new Set(Array.from({ length: 4 }, () => module()))

    expect(
      shouldForceFullReloadForUiHmr({
        file: "/repo/packages/ui/src/components/button.tsx",
        modules: [leaf],
      }),
    ).toBe(false)
  })
})
