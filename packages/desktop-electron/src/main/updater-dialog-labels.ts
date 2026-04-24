import type { MenuLocale } from "./menu-labels"

type FailedLabels = {
  title: string
  fallbackMessage: string
  installFailedMessage: string
  reasonCopy: Partial<Record<"check" | "download" | "metadata" | "cache", string>>
  currentVersionUnaffected: string
  buttons: { retry: string; openDownloadPage: string; later: string }
}

type Labels = {
  busy: { title: string; message: string }
  disabled: { title: string; message: string }
  failed: FailedLabels
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
      title: "Update Failed",
      fallbackMessage: "Failed to check for updates.",
      installFailedMessage: "Installation failed.",
      reasonCopy: {
        check: "Could not reach GitHub. The network may be slow or blocked.",
        download: "The download did not complete.",
        metadata: "The update information was incomplete or invalid.",
        cache: "The cached update is in an unexpected state.",
      },
      currentVersionUnaffected: "Your current version is unaffected and continues to work.",
      buttons: { retry: "Retry", openDownloadPage: "Open Download Page", later: "Later" },
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
      message: "正在检查更新。",
    },
    disabled: {
      title: "更新不可用",
      message: "此构建不支持更新。",
    },
    failed: {
      title: "更新失败",
      fallbackMessage: "检查更新失败。",
      installFailedMessage: "安装失败。",
      reasonCopy: {
        check: "无法连接 GitHub。网络可能较慢或被阻断。",
        download: "下载未完成。",
        metadata: "更新信息不完整或无效。",
        cache: "缓存的更新处于异常状态。",
      },
      currentVersionUnaffected: "当前版本未受影响，可继续使用。",
      buttons: { retry: "重试", openDownloadPage: "打开下载页", later: "稍后" },
    },
    none: {
      title: "没有可用更新",
      message: "已是最新版本。",
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
