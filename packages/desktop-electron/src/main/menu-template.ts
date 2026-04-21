import { menuLabel, type MenuLocale } from "./menu-labels"
import { PAWWORK_GITHUB_ISSUE_URL, PAWWORK_GITHUB_URL } from "./support-links"

export type MenuItemTemplate = {
  label?: string
  role?: string
  type?: "separator"
  accelerator?: string
  enabled?: boolean
  submenu?: MenuItemTemplate[]
  click?: () => void
}

export type MenuTemplateDeps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  reload: () => void
  relaunch: () => void
  reportProblem: () => void
  openExternal: (url: string) => void
  newWindow: () => void
}

type BuildMenuOptions = {
  deps: MenuTemplateDeps
  appName: string
  locale: MenuLocale
  feedbackEnabled: boolean
}

export function buildMenuTemplate(options: BuildMenuOptions): MenuItemTemplate[] {
  const { deps, appName, locale, feedbackEnabled } = options
  const t = (key: Parameters<typeof menuLabel>[1]) => menuLabel(locale, key)

  const helpSubmenu: MenuItemTemplate[] = [
    { label: t("pawworkOnGithub"), click: () => deps.openExternal(PAWWORK_GITHUB_URL) },
    { type: "separator" },
  ]

  if (feedbackEnabled) {
    helpSubmenu.push({ label: t("reportProblem"), click: () => deps.reportProblem() })
  }

  helpSubmenu.push({ label: t("openGithubIssue"), click: () => deps.openExternal(PAWWORK_GITHUB_ISSUE_URL) })

  return [
    {
      label: appName,
      submenu: [
        { role: "about" },
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
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: t("file"),
      submenu: [
        { label: t("newSession"), accelerator: "Shift+Cmd+S", click: () => deps.trigger("session.new") },
        { label: t("openProject"), accelerator: "Cmd+O", click: () => deps.trigger("project.open") },
        { label: t("newWindow"), accelerator: "Cmd+Shift+N", click: () => deps.newWindow() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: t("edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: t("view"),
      submenu: [
        { label: t("toggleSidebar"), accelerator: "Cmd+B", click: () => deps.trigger("sidebar.toggle") },
        { label: t("toggleTerminal"), accelerator: "Ctrl+`", click: () => deps.trigger("terminal.toggle") },
        { label: t("toggleFileTree"), click: () => deps.trigger("fileTree.toggle") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: t("go"),
      submenu: [
        { label: t("back"), accelerator: "Cmd+[", click: () => deps.trigger("common.goBack") },
        { label: t("forward"), accelerator: "Cmd+]", click: () => deps.trigger("common.goForward") },
        { type: "separator" },
        { label: t("previousSession"), accelerator: "Option+Up", click: () => deps.trigger("session.previous") },
        { label: t("nextSession"), accelerator: "Option+Down", click: () => deps.trigger("session.next") },
        { type: "separator" },
        { label: t("previousProject"), accelerator: "Cmd+Option+Up", click: () => deps.trigger("project.previous") },
        { label: t("nextProject"), accelerator: "Cmd+Option+Down", click: () => deps.trigger("project.next") },
      ],
    },
    { role: "windowMenu" },
    {
      label: t("help"),
      submenu: helpSubmenu,
    },
  ]
}
