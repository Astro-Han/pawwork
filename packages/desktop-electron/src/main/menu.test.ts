import { describe, expect, mock, test } from "bun:test"
import { buildMenuTemplate, type MenuItemTemplate } from "./menu-template"

function deps() {
  return {
    trigger: mock(() => undefined),
    checkForUpdates: mock(() => undefined),
    reload: mock(() => undefined),
    relaunch: mock(() => undefined),
    reportProblem: mock(() => undefined),
    openExternal: mock(() => undefined),
    newWindow: mock(() => undefined),
  }
}

function labels(template: MenuItemTemplate[]) {
  return template.map((item) => item.label ?? item.role ?? "")
}

function submenu(template: MenuItemTemplate[], label: string) {
  const item = menuItem(template, label)
  expect(item, `menu '${label}' not found`).toBeDefined()
  return item?.submenu ?? []
}

function menuItem(template: MenuItemTemplate[], label: string) {
  return template.find((item) => item.label === label)
}

function expectRoleLabels(items: MenuItemTemplate[], expected: Record<string, string>) {
  const roleItems = items.filter((item) => item.role !== undefined)
  expect(roleItems).toHaveLength(Object.keys(expected).length)
  for (const [role, label] of Object.entries(expected)) {
    expect(items).toContainEqual(expect.objectContaining({ role, label }))
  }
}

function expectWindowMenuRoleLabels(template: MenuItemTemplate[], locale: "en" | "zh", appName: string) {
  const labelsByLocale = {
    en: {
      appMenu: {
        about: `About ${appName}`,
        hide: `Hide ${appName}`,
        hideOthers: "Hide Others",
        unhide: "Show All",
        quit: `Quit ${appName}`,
      },
      file: {
        close: "Close Window",
      },
      edit: {
        undo: "Undo",
        redo: "Redo",
        cut: "Cut",
        copy: "Copy",
        paste: "Paste",
        selectAll: "Select All",
      },
      view: {
        reload: "Reload",
        toggleDevTools: "Toggle Developer Tools",
        resetZoom: "Actual Size",
        zoomIn: "Zoom In",
        zoomOut: "Zoom Out",
        togglefullscreen: "Toggle Full Screen",
      },
      windowMenu: {
        label: "Window",
        minimize: "Minimize",
        zoom: "Zoom",
        front: "Bring All to Front",
      },
    },
    zh: {
      appMenu: {
        about: `关于 ${appName}`,
        hide: `隐藏 ${appName}`,
        hideOthers: "隐藏其他",
        unhide: "显示全部",
        quit: `退出 ${appName}`,
      },
      file: {
        close: "关闭窗口",
      },
      edit: {
        undo: "撤销",
        redo: "重做",
        cut: "剪切",
        copy: "复制",
        paste: "粘贴",
        selectAll: "全选",
      },
      view: {
        reload: "重新加载",
        toggleDevTools: "切换开发者工具",
        resetZoom: "实际大小",
        zoomIn: "放大",
        zoomOut: "缩小",
        togglefullscreen: "切换全屏",
      },
      windowMenu: {
        label: "窗口",
        minimize: "最小化",
        zoom: "缩放",
        front: "全部移到前面",
      },
    },
  } as const

  const expected = labelsByLocale[locale]

  expectRoleLabels(submenu(template, appName), expected.appMenu)
  expectRoleLabels(submenu(template, locale === "zh" ? "文件" : "File"), expected.file)
  expectRoleLabels(submenu(template, locale === "zh" ? "编辑" : "Edit"), expected.edit)
  expectRoleLabels(submenu(template, locale === "zh" ? "视图" : "View"), expected.view)
  expect(menuItem(template, expected.windowMenu.label)).toEqual(expect.objectContaining({ role: "windowMenu" }))
  expectRoleLabels(submenu(template, expected.windowMenu.label), {
    minimize: expected.windowMenu.minimize,
    zoom: expected.windowMenu.zoom,
    front: expected.windowMenu.front,
  })
}

describe("desktop menu template", () => {
  test("localizes PawWork-controlled labels", () => {
    const template = buildMenuTemplate({
      deps: deps(),
      appName: "爪印",
      locale: "zh",
      feedbackEnabled: true,
    })

    expect(labels(template)).toContain("文件")
    expect(labels(template)).toContain("视图")
    expect(labels(template)).toContain("前往")
    expect(labels(template)).toContain("帮助")
    expect(submenu(template, "帮助")).toContainEqual(expect.objectContaining({ label: "在 GitHub 上查看爪印" }))
  })

  test("localizes Chinese labels for role-backed menu items while preserving roles", () => {
    const appName = "爪印"
    const template = buildMenuTemplate({
      deps: deps(),
      appName,
      locale: "zh",
      feedbackEnabled: true,
    })

    expectWindowMenuRoleLabels(template, "zh", appName)
  })

  test("localizes English labels for role-backed menu items while preserving roles", () => {
    const appName = "PawWork"
    const template = buildMenuTemplate({
      deps: deps(),
      appName,
      locale: "en",
      feedbackEnabled: true,
    })

    expectWindowMenuRoleLabels(template, "en", appName)
  })

  test("renames stale webview label", () => {
    const template = buildMenuTemplate({
      deps: deps(),
      appName: "PawWork Dev",
      locale: "en",
      feedbackEnabled: true,
    })
    const appMenu = submenu(template, "PawWork Dev")

    expect(appMenu.some((item) => item.label === "Reload Window")).toBe(true)
    expect(appMenu.some((item) => item.label === "Reload Webview")).toBe(false)
  })

  test("keeps check for updates clickable", () => {
    const menuDeps = deps()
    const template = buildMenuTemplate({
      deps: menuDeps,
      appName: "PawWork",
      locale: "en",
      feedbackEnabled: true,
    })
    const appMenu = submenu(template, "PawWork")
    const checkForUpdates = appMenu.find((item) => item.label === "Check for Updates...")

    expect(checkForUpdates?.enabled).not.toBe(false)
    expect(checkForUpdates?.click).toBeDefined()
    checkForUpdates?.click?.()
    expect(menuDeps.checkForUpdates).toHaveBeenCalled()
  })

  test("shows report problem only when configured and always keeps github issue", () => {
    const menuDeps = deps()
    const template = buildMenuTemplate({
      deps: menuDeps,
      appName: "PawWork",
      locale: "en",
      feedbackEnabled: false,
    })
    const help = submenu(template, "Help")

    expect(help.some((item) => item.label === "Report a Problem")).toBe(false)
    expect(help.some((item) => item.label === "Open GitHub Issue")).toBe(true)
    help.find((item) => item.label === "Open GitHub Issue")?.click?.()
    expect(menuDeps.openExternal).toHaveBeenCalled()
  })

  test("shows report problem when feedback is configured", () => {
    const menuDeps = deps()
    const template = buildMenuTemplate({
      deps: menuDeps,
      appName: "PawWork",
      locale: "en",
      feedbackEnabled: true,
    })
    const help = submenu(template, "Help")

    expect(help.some((item) => item.label === "Report a Problem")).toBe(true)
    expect(help.some((item) => item.label === "Open GitHub Issue")).toBe(true)
    help.find((item) => item.label === "Report a Problem")?.click?.()
    help.find((item) => item.label === "Open GitHub Issue")?.click?.()
    expect(menuDeps.reportProblem).toHaveBeenCalled()
    expect(menuDeps.openExternal).toHaveBeenCalled()
  })
})
