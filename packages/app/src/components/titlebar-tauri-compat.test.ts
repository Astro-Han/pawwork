import { describe, expect, test } from "bun:test"

async function readSource(path: string, description: string) {
  const url = new URL(path, import.meta.url)

  try {
    return await Bun.file(url).text()
  } catch (err) {
    throw new Error(`Expected ${description} at ${url.pathname}. Update this test if the monorepo layout changes.`, {
      cause: err,
    })
  }
}

const titlebarSource = await readSource("./titlebar.tsx", "titlebar component source")
// Monorepo layout: packages/app/src/components -> packages/ui/src/styles.
const baseCssSource = await readSource("../../../ui/src/styles/base.css", "shared UI base CSS")

describe("titlebar Tauri compatibility cleanup", () => {
  test("titlebar no longer references Tauri globals or Tauri DOM attributes", () => {
    expect(titlebarSource).not.toContain("__TAURI__")
    expect(titlebarSource).not.toContain("tauriApi")
    expect(titlebarSource).not.toContain("data-tauri")
    expect(titlebarSource).not.toContain("Tauri")
  })

  test("titlebar uses shell-neutral drag regions", () => {
    expect(titlebarSource).toContain("data-shell-drag-region")
    expect(baseCssSource).toContain("[data-shell-drag-region]")
    expect(baseCssSource).toContain("app-region: drag")
    expect(baseCssSource).toContain("app-region: no-drag")
    expect(baseCssSource).not.toContain("data-tauri-drag-region")
  })
})
