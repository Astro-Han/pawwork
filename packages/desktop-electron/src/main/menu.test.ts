import { describe, expect, test } from "bun:test"
import { buildMenuTemplate, type MenuItemTemplate } from "./menu-template"

const deps = {
  trigger: () => undefined,
  checkForUpdates: () => undefined,
  reload: () => undefined,
  relaunch: () => undefined,
  reportProblem: () => undefined,
  openExternal: () => undefined,
  newWindow: () => undefined,
}

function labels(template: MenuItemTemplate[]) {
  return template.map((item) => item.label ?? item.role ?? "")
}

function submenu(template: MenuItemTemplate[], label: string) {
  return template.find((item) => item.label === label)?.submenu ?? []
}

describe("desktop menu template", () => {
  test("localizes PawWork-controlled labels", () => {
    const template = buildMenuTemplate({
      deps,
      appName: "PawWork",
      locale: "zh",
      feedbackEnabled: true,
    })

    expect(labels(template)).toContain("文件")
    expect(labels(template)).toContain("视图")
    expect(labels(template)).toContain("前往")
    expect(labels(template)).toContain("帮助")
  })

  test("renames stale webview label", () => {
    const template = buildMenuTemplate({
      deps,
      appName: "PawWork Dev",
      locale: "en",
      feedbackEnabled: true,
    })
    const appMenu = submenu(template, "PawWork Dev")

    expect(appMenu.some((item) => item.label === "Reload Window")).toBe(true)
    expect(appMenu.some((item) => item.label === "Reload Webview")).toBe(false)
  })

  test("keeps check for updates clickable", () => {
    const template = buildMenuTemplate({
      deps,
      appName: "PawWork",
      locale: "en",
      feedbackEnabled: true,
    })
    const appMenu = submenu(template, "PawWork")
    const checkForUpdates = appMenu.find((item) => item.label === "Check for Updates...")

    expect(checkForUpdates?.enabled).not.toBe(false)
    expect(checkForUpdates?.click).toBeDefined()
  })

  test("shows report problem only when configured and always keeps github issue", () => {
    const template = buildMenuTemplate({
      deps,
      appName: "PawWork",
      locale: "en",
      feedbackEnabled: false,
    })
    const help = submenu(template, "Help")

    expect(help.some((item) => item.label === "Report a Problem")).toBe(false)
    expect(help.some((item) => item.label === "Open GitHub Issue")).toBe(true)
  })

  test("shows report problem when feedback is configured", () => {
    const template = buildMenuTemplate({
      deps,
      appName: "PawWork",
      locale: "en",
      feedbackEnabled: true,
    })
    const help = submenu(template, "Help")

    expect(help.some((item) => item.label === "Report a Problem")).toBe(true)
    expect(help.some((item) => item.label === "Open GitHub Issue")).toBe(true)
  })
})
