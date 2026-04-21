export type MenuLocale = "en" | "zh"

export type MenuLabelKey =
  | "file"
  | "edit"
  | "view"
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

const labels: Record<MenuLocale, Record<MenuLabelKey, string>> = {
  en: {
    file: "File",
    edit: "Edit",
    view: "View",
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
    pawworkOnGithub: "PawWork 在 GitHub",
    reportProblem: "报告问题",
    openGithubIssue: "打开 GitHub Issue",
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
