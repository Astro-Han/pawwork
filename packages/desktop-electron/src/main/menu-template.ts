import type { BrowserWindow, MenuItem } from "electron"

import { menuLabel, menuRoleLabel, type MenuLocale, type MenuRoleLabelKey } from "./menu-labels"
import { PAWWORK_GITHUB_ISSUE_URL, PAWWORK_GITHUB_URL } from "./support-links"

export type MenuItemTemplate = {
  label?: string
  role?: string
  type?: "separator"
  accelerator?: string
  enabled?: boolean
  submenu?: MenuItemTemplate[]
  click?: (menuItem?: MenuItem, browserWindow?: BrowserWindow) => void
}

export type MenuTemplateDeps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  reload: () => void
  relaunch: () => void
  reportProblem: () => void
  exportDiagnosticsLog: () => void
  openExternal: (url: string) => void
  newWindow: () => void
  triggerAbout: (browserWindow?: BrowserWindow) => void
}

type BuildMenuOptions = {
  deps: MenuTemplateDeps
  appName: string
  locale: MenuLocale
  feedbackEnabled: boolean
}

export function buildMacosMenuTemplate(options: BuildMenuOptions): MenuItemTemplate[] {
  const { deps, appName, locale } = options
  const t = (key: Parameters<typeof menuLabel>[1]) => menuLabel(locale, key)
  const roleLabel = (key: MenuRoleLabelKey) => menuRoleLabel(locale, key, appName)

  const helpSubmenu: MenuItemTemplate[] = [
    { label: t("pawworkOnGithub"), click: () => deps.openExternal(PAWWORK_GITHUB_URL) },
    { type: "separator" },
  ]

  helpSubmenu.push({ label: t("reportProblem"), click: () => deps.reportProblem() })

  helpSubmenu.push({ label: t("openGithubIssue"), click: () => deps.openExternal(PAWWORK_GITHUB_ISSUE_URL) })

  return [
    {
      label: appName,
      submenu: [
        { label: roleLabel("about"), role: "about" },
        {
          label: t("checkForUpdates"),
          click: () => deps.checkForUpdates(),
        },
        {
          label: t("reloadWindow"),
          click: () => deps.reload(),
        },
        {
          label: t("restart"),
          click: () => deps.relaunch(),
        },
        { type: "separator" },
        { label: roleLabel("hide"), role: "hide" },
        { label: roleLabel("hideOthers"), role: "hideOthers" },
        { label: roleLabel("unhide"), role: "unhide" },
        { type: "separator" },
        { label: roleLabel("quit"), role: "quit" },
      ],
    },
    {
      label: t("file"),
      submenu: [
        { label: t("newSession"), accelerator: "CmdOrCtrl+Shift+S", click: () => deps.trigger("session.new") },
        { label: t("openProject"), accelerator: "CmdOrCtrl+O", click: () => deps.trigger("project.open") },
        { label: t("newWindow"), accelerator: "CmdOrCtrl+Shift+N", click: () => deps.newWindow() },
        { type: "separator" },
        { label: roleLabel("close"), role: "close" },
      ],
    },
    {
      label: t("edit"),
      submenu: [
        { label: roleLabel("undo"), role: "undo" },
        { label: roleLabel("redo"), role: "redo" },
        { type: "separator" },
        { label: roleLabel("cut"), role: "cut" },
        { label: roleLabel("copy"), role: "copy" },
        { label: roleLabel("paste"), role: "paste" },
        { label: roleLabel("selectAll"), role: "selectAll" },
      ],
    },
    {
      label: t("view"),
      submenu: [
        { label: t("toggleSidebar"), accelerator: "CmdOrCtrl+B", click: () => deps.trigger("sidebar.toggle") },
        { label: t("toggleTerminal"), accelerator: "Ctrl+`", click: () => deps.trigger("terminal.toggle") },
        { label: t("toggleFileTree"), click: () => deps.trigger("fileTree.toggle") },
        { type: "separator" },
        { label: roleLabel("reload"), role: "reload" },
        { label: roleLabel("toggleDevTools"), role: "toggleDevTools" },
        { type: "separator" },
        { label: roleLabel("resetZoom"), role: "resetZoom" },
        { label: roleLabel("zoomIn"), role: "zoomIn" },
        { label: roleLabel("zoomOut"), role: "zoomOut" },
        { type: "separator" },
        { label: roleLabel("togglefullscreen"), role: "togglefullscreen" },
      ],
    },
    {
      label: t("go"),
      submenu: [
        { label: t("back"), accelerator: "CmdOrCtrl+[", click: () => deps.trigger("common.goBack") },
        { label: t("forward"), accelerator: "CmdOrCtrl+]", click: () => deps.trigger("common.goForward") },
        { type: "separator" },
        { label: t("previousSession"), accelerator: "Alt+Up", click: () => deps.trigger("session.previous") },
        { label: t("nextSession"), accelerator: "Alt+Down", click: () => deps.trigger("session.next") },
        { type: "separator" },
        { label: t("previousProject"), accelerator: "CmdOrCtrl+Alt+Up", click: () => deps.trigger("project.previous") },
        { label: t("nextProject"), accelerator: "CmdOrCtrl+Alt+Down", click: () => deps.trigger("project.next") },
      ],
    },
    {
      label: t("window"),
      // Electron 40.8.0 on macOS 15 still keeps our labeled submenu entries while
      // preserving the native window list for the parent windowMenu role.
      // If an Electron upgrade stops honoring this merge, localize the generated
      // window submenu items after Menu.buildFromTemplate instead of dropping the role.
      role: "windowMenu",
      submenu: [
        { label: roleLabel("minimize"), role: "minimize" },
        { label: roleLabel("zoom"), role: "zoom" },
        { type: "separator" },
        { label: roleLabel("front"), role: "front" },
      ],
    },
    {
      label: t("help"),
      submenu: helpSubmenu,
    },
  ]
}

export function buildWindowsMenuTemplate(options: BuildMenuOptions): MenuItemTemplate[] {
  const { deps, locale, appName } = options
  const t = (key: Parameters<typeof menuLabel>[1]) => menuLabel(locale, key)
  const roleLabel = (key: MenuRoleLabelKey) => menuRoleLabel(locale, key, appName)

  const helpSubmenu: MenuItemTemplate[] = [
    { label: t("pawworkOnGithub"), click: () => deps.openExternal(PAWWORK_GITHUB_URL) },
    { type: "separator" },
  ]
  helpSubmenu.push({ label: t("reportProblem"), click: () => deps.reportProblem() })
  helpSubmenu.push({ label: t("openGithubIssue"), click: () => deps.openExternal(PAWWORK_GITHUB_ISSUE_URL) })
  helpSubmenu.push({ type: "separator" })
  helpSubmenu.push({ label: t("checkForUpdates"), click: () => deps.checkForUpdates() })
  helpSubmenu.push({ type: "separator" })
  helpSubmenu.push({ label: roleLabel("about"), click: (_item, win) => deps.triggerAbout(win) })

  return [
    {
      label: t("file"),
      submenu: [
        { label: t("newSession"), accelerator: "CmdOrCtrl+Shift+S", click: () => deps.trigger("session.new") },
        { label: t("openProject"), accelerator: "CmdOrCtrl+O", click: () => deps.trigger("project.open") },
        { label: t("newWindow"), accelerator: "CmdOrCtrl+Shift+N", click: () => deps.newWindow() },
        { type: "separator" },
        { label: roleLabel("close"), role: "close" },
        { label: roleLabel("quit"), role: "quit" },
      ],
    },
    {
      label: t("edit"),
      submenu: [
        { label: roleLabel("undo"), role: "undo" },
        { label: roleLabel("redo"), role: "redo" },
        { type: "separator" },
        { label: roleLabel("cut"), role: "cut" },
        { label: roleLabel("copy"), role: "copy" },
        { label: roleLabel("paste"), role: "paste" },
        { label: roleLabel("selectAll"), role: "selectAll" },
      ],
    },
    {
      label: t("view"),
      submenu: [
        { label: t("toggleSidebar"), accelerator: "CmdOrCtrl+B", click: () => deps.trigger("sidebar.toggle") },
        { label: t("toggleTerminal"), accelerator: "CmdOrCtrl+`", click: () => deps.trigger("terminal.toggle") },
        { label: t("toggleFileTree"), click: () => deps.trigger("fileTree.toggle") },
        { type: "separator" },
        { label: roleLabel("reload"), role: "reload" },
        { label: roleLabel("toggleDevTools"), role: "toggleDevTools" },
        { type: "separator" },
        { label: roleLabel("resetZoom"), role: "resetZoom" },
        { label: roleLabel("zoomIn"), role: "zoomIn" },
        { label: roleLabel("zoomOut"), role: "zoomOut" },
        { type: "separator" },
        { label: roleLabel("togglefullscreen"), role: "togglefullscreen" },
      ],
    },
    {
      label: t("go"),
      submenu: [
        { label: t("back"), accelerator: "CmdOrCtrl+[", click: () => deps.trigger("common.goBack") },
        { label: t("forward"), accelerator: "CmdOrCtrl+]", click: () => deps.trigger("common.goForward") },
        { type: "separator" },
        { label: t("previousSession"), accelerator: "Alt+Up", click: () => deps.trigger("session.previous") },
        { label: t("nextSession"), accelerator: "Alt+Down", click: () => deps.trigger("session.next") },
        { type: "separator" },
        { label: t("previousProject"), accelerator: "CmdOrCtrl+Alt+Up", click: () => deps.trigger("project.previous") },
        { label: t("nextProject"), accelerator: "CmdOrCtrl+Alt+Down", click: () => deps.trigger("project.next") },
      ],
    },
    {
      label: t("window"),
      role: "windowMenu",
      submenu: [
        { label: roleLabel("minimize"), role: "minimize" },
        { label: roleLabel("zoom"), role: "zoom" },
      ],
    },
    {
      label: t("help"),
      submenu: helpSubmenu,
    },
  ]
}
