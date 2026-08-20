export type MenuLocale = "en" | "zh"

export type MenuLabelKey =
  | "file"
  | "edit"
  | "view"
  | "window"
  | "help"
  | "checkForUpdates"
  | "reloadWindow"
  | "restart"
  | "newWindow"
  | "pawworkOnGithub"
  | "openGithubIssue"

export type MenuRoleLabelKey =
  | "about"
  | "hide"
  | "hideOthers"
  | "quit"
  | "close"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "reload"
  | "toggleDevTools"
  | "togglefullscreen"
  | "minimize"
  | "zoom"

const labels: Record<MenuLocale, Record<MenuLabelKey, string>> = {
  en: {
    file: "File",
    edit: "Edit",
    view: "View",
    window: "Window",
    help: "Help",
    checkForUpdates: "Check for Updates...",
    reloadWindow: "Reload Window",
    restart: "Restart",
    newWindow: "New Window",
    pawworkOnGithub: "PawWork on GitHub",
    openGithubIssue: "Open GitHub Issue",
  },
  zh: {
    file: "文件",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    help: "帮助",
    checkForUpdates: "检查更新...",
    reloadWindow: "重新加载窗口",
    restart: "重启",
    newWindow: "新建窗口",
    pawworkOnGithub: "在 GitHub 上查看爪印",
    openGithubIssue: "打开 GitHub Issue",
  },
}

// Keep explicit English role labels so role-backed menu templates stay deterministic
// in unit tests and non-macOS environments instead of depending on Electron runtime defaults.
const roleLabels: Record<MenuLocale, Record<MenuRoleLabelKey, string>> = {
  en: {
    about: "About {appName}",
    hide: "Hide {appName}",
    hideOthers: "Hide Others",
    quit: "Quit {appName}",
    close: "Close Window",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    reload: "Reload",
    toggleDevTools: "Toggle Developer Tools",
    togglefullscreen: "Toggle Full Screen",
    minimize: "Minimize",
    zoom: "Zoom",
  },
  zh: {
    about: "关于 {appName}",
    hide: "隐藏 {appName}",
    hideOthers: "隐藏其他",
    quit: "退出 {appName}",
    close: "关闭窗口",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    reload: "重新加载",
    toggleDevTools: "切换开发者工具",
    togglefullscreen: "切换全屏",
    minimize: "最小化",
    zoom: "缩放",
  },
}

export function detectSystemMenuLocale(locale: string | null | undefined): MenuLocale {
  if (locale?.toLowerCase().startsWith("zh")) return "zh"
  return "en"
}

export function menuLabel(locale: MenuLocale, key: MenuLabelKey) {
  return labels[locale][key]
}

export function menuRoleLabel(locale: MenuLocale, key: MenuRoleLabelKey, appName: string) {
  return roleLabels[locale][key].replaceAll("{appName}", appName)
}
