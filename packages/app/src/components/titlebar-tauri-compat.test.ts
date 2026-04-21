import { describe, expect, test } from "bun:test"

const titlebarSource = await Bun.file(new URL("./titlebar.tsx", import.meta.url)).text()
const baseCssSource = await Bun.file(new URL("../../../ui/src/styles/base.css", import.meta.url)).text()

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
