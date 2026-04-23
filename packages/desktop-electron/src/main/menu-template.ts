import { menuLabel, menuRoleLabel, type MenuLocale, type MenuRoleLabelKey } from "./menu-labels"
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
  const roleLabel = (key: MenuRoleLabelKey) => menuRoleLabel(locale, key, appName)

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
        { label: t("newSession"), accelerator: "Shift+Cmd+S", click: () => deps.trigger("session.new") },
        { label: t("openProject"), accelerator: "Cmd+O", click: () => deps.trigger("project.open") },
        { label: t("newWindow"), accelerator: "Cmd+Shift+N", click: () => deps.newWindow() },
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
        { label: t("toggleSidebar"), accelerator: "Cmd+B", click: () => deps.trigger("sidebar.toggle") },
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
