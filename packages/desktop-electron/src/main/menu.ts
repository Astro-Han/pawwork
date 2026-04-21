import { app, Menu, shell } from "electron"

import { FEEDBACK_FORM_URL } from "./constants"
import { readStoredMenuLocale } from "./menu-i18n"
import { buildMenuTemplate, type MenuTemplateDeps } from "./menu-template"

type Deps = Omit<MenuTemplateDeps, "openExternal">

export function createMenu(deps: Deps, locale = readStoredMenuLocale(app.getLocale())) {
  if (process.platform !== "darwin") return

  const template = buildMenuTemplate({
    deps: {
      ...deps,
      openExternal: (url) => {
        void shell.openExternal(url).catch((error) => {
          console.warn("[menu] failed to open external url", { url, error })
        })
      },
    },
    appName: app.getName(),
    locale,
    feedbackEnabled: Boolean(FEEDBACK_FORM_URL),
  }) as Electron.MenuItemConstructorOptions[]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
