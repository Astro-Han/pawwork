import type { MenuLocale } from "./menu-labels"

type Labels = {
  busy: { title: string; message: string }
  disabled: { title: string; message: string }
  failed: { title: string; fallbackMessage: string }
  none: { title: string; message: string }
  ready: { title: string; message: (version?: string) => string; buttons: [string, string] }
}

const labels: Record<MenuLocale, Labels> = {
  en: {
    busy: {
      title: "Update Check in Progress",
      message: "PawWork is already checking for updates.",
    },
    disabled: {
      title: "Updates Unavailable",
      message: "Updates are not available in this build.",
    },
    failed: {
      title: "Update Check Failed",
      fallbackMessage: "Failed to check for updates.",
    },
    none: {
      title: "No Updates",
      message: "You're up to date.",
    },
    ready: {
      title: "Update Ready",
      message: (version) => (version ? `Update ${version} downloaded. Restart now?` : "Update downloaded. Restart now?"),
      buttons: ["Restart", "Later"],
    },
  },
  zh: {
    busy: {
      title: "正在检查更新",
      message: "PawWork 正在检查更新。",
    },
    disabled: {
      title: "更新不可用",
      message: "此构建不支持更新。",
    },
    failed: {
      title: "检查更新失败",
      fallbackMessage: "检查更新失败。",
    },
    none: {
      title: "没有可用更新",
      message: "PawWork 已是最新版本。",
    },
    ready: {
      title: "更新已准备好",
      message: (version) => (version ? `更新 ${version} 已下载。现在重启？` : "更新已下载。现在重启？"),
      buttons: ["重启", "稍后"],
    },
  },
}

export function updaterDialogLabels(locale: MenuLocale) {
  // Runtime fallback for unexpected locale values crossing process boundaries.
  return labels[locale] ?? labels.en
}
