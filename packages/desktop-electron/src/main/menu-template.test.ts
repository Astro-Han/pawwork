import { expect, test } from "bun:test"
import { buildMacosMenuTemplate, buildWindowsMenuTemplate, type MenuTemplateDeps } from "./menu-template"

const stubDeps: MenuTemplateDeps = {
  trigger: () => {},
  checkForUpdates: () => {},
  reload: () => {},
  relaunch: () => {},
  reportProblem: () => {},
  exportDiagnosticsLog: () => {},
  openExternal: () => {},
  newWindow: () => {},
  triggerAbout: () => {},
}

const baseOptions = {
  deps: stubDeps,
  appName: "PawWork",
  locale: "en" as const,
  feedbackEnabled: true,
}

test("Windows template has 6 top-level menus: File / Edit / View / Go / Window / Help", () => {
  const tpl = buildWindowsMenuTemplate(baseOptions)
  expect(tpl).toHaveLength(6)
  const labels = tpl.map((m) => m.label)
  expect(labels).toEqual(["File", "Edit", "View", "Go", "Window", "Help"])
})

test("Windows Help submenu contains 'Check for Updates' and 'About PawWork'", () => {
  const tpl = buildWindowsMenuTemplate(baseOptions)
  const help = tpl.find((m) => m.label === "Help")
  expect(help).toBeDefined()
  const labels = (help?.submenu ?? []).map((s) => s.label)
  expect(labels).toContain("Check for Updates...")
  expect(labels).toContain("About PawWork")
})

test("Help submenu exposes diagnostics export", () => {
  const windows = buildWindowsMenuTemplate(baseOptions)
  const macos = buildMacosMenuTemplate(baseOptions)
  expect((windows.find((m) => m.label === "Help")?.submenu ?? []).map((s) => s.label)).toContain(
    "Export Diagnostics Log...",
  )
  expect((macos.find((m) => m.label === "Help")?.submenu ?? []).map((s) => s.label)).toContain(
    "Export Diagnostics Log...",
  )
})

test("Windows New Session accelerator matches macOS (CmdOrCtrl+Shift+S)", () => {
  const tpl = buildWindowsMenuTemplate(baseOptions)
  const file = tpl.find((m) => m.label === "File")
  const newSession = (file?.submenu ?? []).find((s) => s.label === "New Session")
  expect(newSession?.accelerator).toBe("CmdOrCtrl+Shift+S")
})

test("Windows accelerators use CmdOrCtrl + Alt (no bare Cmd or Option)", () => {
  const tpl = buildWindowsMenuTemplate(baseOptions)
  const collect = (items: ReturnType<typeof buildWindowsMenuTemplate>): string[] =>
    items.flatMap((i) => [i.accelerator ?? "", ...collect(i.submenu ?? [])])
  const accels = collect(tpl).filter(Boolean)
  for (const a of accels) {
    expect(a).not.toMatch(/(^|\+)Cmd(\+|$)/)
    expect(a).not.toMatch(/(^|\+)Option(\+|$)/)
  }
  expect(accels.some((a) => a === "CmdOrCtrl+Shift+S")).toBe(true)
})

test("macOS template still has 7 top-level menus including PawWork app menu", () => {
  const tpl = buildMacosMenuTemplate(baseOptions)
  expect(tpl).toHaveLength(7)
  expect(tpl[0].label).toBe("PawWork")
})

test("macOS About menu item still uses role:about (system About panel)", () => {
  const tpl = buildMacosMenuTemplate(baseOptions)
  const appMenu = tpl[0]
  const aboutItem = (appMenu.submenu ?? []).find((s) => s.role === "about")
  expect(aboutItem).toBeTruthy()
})
