import { app, BrowserWindow, Menu, shell } from "electron"
import log from "electron-log/main.js"
import { localizedAppDisplayName } from "./app-display-name"
import { detectSystemMenuLocale, menuLabel, menuRoleLabel, type MenuLocale } from "./menu-labels"
import { PAWWORK_GITHUB_ISSUE_URL, PAWWORK_GITHUB_URL } from "./support-links"

type DshMenuOptions = {
  checkForUpdates: () => void
  newWindow: () => void
  relaunch: () => void
}

export function createDshMenu(options: DshMenuOptions, locale: MenuLocale = detectSystemMenuLocale(app.getLocale())) {
  if (process.platform !== "darwin" && process.platform !== "win32") return

  const appName = localizedAppDisplayName(app.getName(), locale)
  const label = (key: Parameters<typeof menuLabel>[1]) => menuLabel(locale, key)
  const roleLabel = (key: Parameters<typeof menuRoleLabel>[1]) => menuRoleLabel(locale, key, appName)
  const openExternal = (url: string) => {
    void shell.openExternal(url).catch((error) => log.warn("[menu] failed to open external url", { url, error }))
  }
  const appMenu: Electron.MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { label: roleLabel("about"), role: "about" },
      { label: label("checkForUpdates"), click: options.checkForUpdates },
      { label: label("reloadWindow"), click: () => BrowserWindow.getFocusedWindow()?.reload() },
      { label: label("restart"), click: options.relaunch },
      { type: "separator" },
      { label: roleLabel("hide"), role: "hide" },
      { label: roleLabel("hideOthers"), role: "hideOthers" },
      { type: "separator" },
      { label: roleLabel("quit"), role: "quit" },
    ],
  }
  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: label("file"),
    submenu: [
      { label: label("newWindow"), accelerator: "CmdOrCtrl+Shift+N", click: options.newWindow },
      { type: "separator" },
      { label: roleLabel("close"), role: "close" },
    ],
  }
  const editMenu: Electron.MenuItemConstructorOptions = {
    label: label("edit"),
    submenu: [
      { label: roleLabel("undo"), role: "undo" },
      { label: roleLabel("redo"), role: "redo" },
      { type: "separator" },
      { label: roleLabel("cut"), role: "cut" },
      { label: roleLabel("copy"), role: "copy" },
      { label: roleLabel("paste"), role: "paste" },
      { label: roleLabel("selectAll"), role: "selectAll" },
    ],
  }
  const viewMenu: Electron.MenuItemConstructorOptions = {
    label: label("view"),
    submenu: [
      { label: roleLabel("reload"), role: "reload" },
      { label: roleLabel("toggleDevTools"), role: "toggleDevTools" },
      { type: "separator" },
      { label: roleLabel("togglefullscreen"), role: "togglefullscreen" },
    ],
  }
  const windowMenu: Electron.MenuItemConstructorOptions = {
    label: label("window"),
    role: "windowMenu",
    submenu: [
      { label: roleLabel("minimize"), role: "minimize" },
      { label: roleLabel("zoom"), role: "zoom" },
    ],
  }
  const helpMenu: Electron.MenuItemConstructorOptions = {
    label: label("help"),
    submenu: [
      { label: label("pawworkOnGithub"), click: () => openExternal(PAWWORK_GITHUB_URL) },
      { label: label("openGithubIssue"), click: () => openExternal(PAWWORK_GITHUB_ISSUE_URL) },
    ],
  }

  const template =
    process.platform === "darwin"
      ? [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu]
      : [fileMenu, editMenu, viewMenu, windowMenu, helpMenu]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
