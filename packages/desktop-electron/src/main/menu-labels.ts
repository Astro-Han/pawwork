export type MenuLocale = "en" | "zh"

export type MenuLabelKey =
  | "file"
  | "edit"
  | "view"
  | "window"
  | "go"
  | "help"
  | "checkForUpdates"
  | "reloadWindow"
  | "restart"
  | "newSession"
  | "openProject"
  | "newWindow"
  | "toggleSidebar"
  | "toggleTerminal"
  | "toggleFileTree"
  | "back"
  | "forward"
  | "previousSession"
  | "nextSession"
  | "previousProject"
  | "nextProject"
  | "pawworkOnGithub"
  | "reportProblem"
  | "openGithubIssue"

export type MenuRoleLabelKey =
  | "about"
  | "hide"
  | "hideOthers"
  | "unhide"
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
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
  | "togglefullscreen"
  | "minimize"
  | "zoom"
  | "front"

const labels: Record<MenuLocale, Record<MenuLabelKey, string>> = {
  en: {
    file: "File",
    edit: "Edit",
    view: "View",
    window: "Window",
    go: "Go",
    help: "Help",
    checkForUpdates: "Check for Updates...",
    reloadWindow: "Reload Window",
    restart: "Restart",
    newSession: "New Session",
    openProject: "Open Project...",
    newWindow: "New Window",
    toggleSidebar: "Toggle Sidebar",
    toggleTerminal: "Toggle Terminal",
    toggleFileTree: "Toggle File Tree",
    back: "Back",
    forward: "Forward",
    previousSession: "Previous Session",
    nextSession: "Next Session",
    previousProject: "Previous Project",
    nextProject: "Next Project",
    pawworkOnGithub: "PawWork on GitHub",
    reportProblem: "Report a Problem",
    openGithubIssue: "Open GitHub Issue",
  },
  zh: {
    file: "文件",
    edit: "编辑",
    view: "视图",
    window: "窗口",
    go: "前往",
    help: "帮助",
    checkForUpdates: "检查更新...",
    reloadWindow: "重新加载窗口",
    restart: "重启",
    newSession: "新建会话",
    openProject: "打开项目...",
    newWindow: "新建窗口",
    toggleSidebar: "切换侧边栏",
    toggleTerminal: "切换终端",
    toggleFileTree: "切换文件树",
    back: "后退",
    forward: "前进",
    previousSession: "上一个会话",
    nextSession: "下一个会话",
    previousProject: "上一个项目",
    nextProject: "下一个项目",
    pawworkOnGithub: "在 GitHub 上查看爪印",
    reportProblem: "报告问题",
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
    unhide: "Show All",
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
    resetZoom: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    togglefullscreen: "Toggle Full Screen",
    minimize: "Minimize",
    zoom: "Zoom",
    front: "Bring All to Front",
  },
  zh: {
    about: "关于 {appName}",
    hide: "隐藏 {appName}",
    hideOthers: "隐藏其他",
    unhide: "显示全部",
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
    resetZoom: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    togglefullscreen: "切换全屏",
    minimize: "最小化",
    zoom: "缩放",
    front: "全部移到前面",
  },
}

function parseStoredOrRaw(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function parseMenuLocale(value: unknown): MenuLocale {
  const parsed = parseStoredOrRaw(value)
  if (typeof parsed === "string") {
    const normalized = parsed.toLowerCase().replaceAll("_", "-")
    if (normalized.startsWith("zh")) return "zh"
    if (normalized.startsWith("en")) return "en"
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const locale = (parsed as Record<string, unknown>).locale
    return parseMenuLocale(locale)
  }
  return "en"
}

export function parseStoredMenuLocale(value: unknown): MenuLocale | undefined {
  if (!value) return undefined
  const parsed = parseStoredOrRaw(value)
  if (typeof parsed === "string") {
    const normalized = parsed.toLowerCase().replaceAll("_", "-")
    if (normalized.startsWith("zh")) return "zh"
    if (normalized.startsWith("en")) return "en"
    return undefined
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parseStoredMenuLocale((parsed as Record<string, unknown>).locale)
  }
  return undefined
}

export function detectSystemMenuLocale(locale: string | null | undefined): MenuLocale {
  if (locale?.toLowerCase().startsWith("zh")) return "zh"
  return "en"
}

export function menuLabel(locale: MenuLocale, key: MenuLabelKey) {
  const value = labels[locale]?.[key] ?? labels.en[key]
  if (value !== undefined) return value
  if (import.meta.env.DEV) console.warn("[menu] missing desktop label", { locale, key })
  return key
}

export function menuRoleLabel(locale: MenuLocale, key: MenuRoleLabelKey, appName: string) {
  if (import.meta.env.DEV && locale !== "en" && roleLabels[locale]?.[key] === undefined) {
    console.warn("[menu] missing locale role label, falling back to en", { locale, key })
  }
  const template = roleLabels[locale]?.[key] ?? roleLabels.en[key] ?? key
  if (template === key && import.meta.env.DEV) console.warn("[menu] missing desktop role label", { locale, key })
  return template.replaceAll("{appName}", appName)
}
