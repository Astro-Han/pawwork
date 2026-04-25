import { app, BrowserWindow, Menu, shell, type MenuItem } from "electron"
// electron-log exposes this ESM entrypoint with the `.js` suffix.
import log from "electron-log/main.js"

import { localizedAppDisplayName } from "./app-display-name"
import { FEEDBACK_FORM_URL } from "./constants"
import { readStoredMenuLocale } from "./menu-i18n"
import {
  buildMacosMenuTemplate,
  buildWindowsMenuTemplate,
  type MenuItemTemplate,
  type MenuTemplateDeps,
} from "./menu-template"

type Deps = Omit<MenuTemplateDeps, "openExternal">

function wrapClicks(items: MenuItemTemplate[]): Electron.MenuItemConstructorOptions[] {
  return items.map((item) => {
    const out: Electron.MenuItemConstructorOptions = {
      label: item.label,
      role: item.role as Electron.MenuItemConstructorOptions["role"],
      type: item.type,
      accelerator: item.accelerator,
      enabled: item.enabled,
    }
    if (item.submenu) out.submenu = wrapClicks(item.submenu)
    if (item.click) {
      out.click = (menuItem: MenuItem, window) => {
        const browserWindow = window instanceof BrowserWindow ? window : undefined
        item.click?.(menuItem, browserWindow)
      }
    }
    return out
  })
}

export function createMenu(deps: Deps, locale = readStoredMenuLocale(app.getLocale())) {
  if (process.platform !== "darwin" && process.platform !== "win32") return // Linux: no menu

  const fullDeps: MenuTemplateDeps = {
    ...deps,
    openExternal: (url) => {
      void shell.openExternal(url).catch((error) => {
        log.warn("[menu] failed to open external url", { url, error })
      })
    },
  }

  const options = {
    deps: fullDeps,
    appName: localizedAppDisplayName(app.getName(), locale),
    locale,
    feedbackEnabled: Boolean(FEEDBACK_FORM_URL),
  }

  const template =
    process.platform === "darwin" ? buildMacosMenuTemplate(options) : buildWindowsMenuTemplate(options)

  Menu.setApplicationMenu(Menu.buildFromTemplate(wrapClicks(template)))
}
