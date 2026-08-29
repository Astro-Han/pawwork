import { describe, expect, test, vi } from "vitest"

// The menu is the only update entry a Windows user has, and it lives or dies
// by which template array carries the item — a platform branch slips and the
// entry is silently gone for one OS. Capture the built template and walk it.

const electron = vi.hoisted(() => ({
  template: undefined as Electron.MenuItemConstructorOptions[] | undefined,
}))

vi.mock("electron", () => ({
  app: { getName: () => "PawWork" },
  BrowserWindow: { getFocusedWindow: () => null },
  Menu: {
    buildFromTemplate: (template: Electron.MenuItemConstructorOptions[]) => {
      electron.template = template
      return template
    },
    setApplicationMenu: () => {},
  },
  shell: { openExternal: async () => {} },
}))

vi.mock("electron-log/main.js", () => ({ default: { warn: () => {} } }))

import { createDshMenu } from "./dsh-menu"

function flatten(items: Electron.MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    typeof item.label === "string" ? item.label : "",
    ...flatten((item.submenu as Electron.MenuItemConstructorOptions[] | undefined) ?? []),
  ])
}

function menuLabels(platform: "darwin" | "win32", locale: "en" | "zh") {
  const original = process.platform
  Object.defineProperty(process, "platform", { value: platform })
  try {
    createDshMenu({ checkForUpdates: () => {}, newWindow: () => {}, relaunch: () => {} }, locale)
  } finally {
    Object.defineProperty(process, "platform", { value: original })
  }
  return flatten(electron.template ?? [])
}

describe("PawWork application menu", () => {
  test("offers check for updates from the macOS app menu", () => {
    expect(menuLabels("darwin", "zh")).toContain("检查更新...")
  })

  test("offers check for updates from the Windows help menu", () => {
    expect(menuLabels("win32", "en")).toContain("Check for Updates...")
  })
})
