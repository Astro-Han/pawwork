import type { MenuLocale } from "./menu-labels"

// Failure copy is split by cause, not shared: the same page renders a runtime
// that never started and one that died mid-session, and a single sentence that
// covers both ends up describing neither.
export type StartupFailureReason = "startup" | "crash"

type Labels = {
  starting: { title: string; message: string }
  failed: Record<StartupFailureReason, { title: string; message: string }>
  details: { summary: string; noOutput: string; logLabel: string }
  actions: { retry: string; reportIssue: string; showLog: string; copyDetails: string; copied: string }
}

const labels: Record<MenuLocale, Labels> = {
  en: {
    starting: {
      title: "Starting PawWork",
      message: "The agent runtime is starting. The first launch on a machine takes the longest.",
    },
    failed: {
      startup: {
        title: "PawWork Could Not Start",
        message: "PawWork's agent runtime did not start.",
      },
      crash: {
        title: "PawWork Stopped",
        message: "PawWork's agent runtime stopped unexpectedly.",
      },
    },
    details: {
      summary: "Details",
      noOutput: "The runtime wrote nothing before it stopped.",
      logLabel: "Full log:",
    },
    actions: {
      retry: "Try Again",
      reportIssue: "Report a Problem",
      showLog: "Show Log",
      copyDetails: "Copy Details",
      copied: "Copied",
    },
  },
  zh: {
    starting: {
      title: "正在启动爪印",
      message: "智能体运行时正在启动，首次在一台机器上启动耗时最长。",
    },
    failed: {
      startup: {
        title: "爪印无法启动",
        message: "爪印的智能体运行时未能启动。",
      },
      crash: {
        title: "爪印已停止",
        message: "爪印的智能体运行时意外退出。",
      },
    },
    details: {
      summary: "详情",
      noOutput: "运行时在退出前没有任何输出。",
      logLabel: "完整日志：",
    },
    actions: {
      retry: "重试",
      reportIssue: "反馈问题",
      showLog: "显示日志",
      copyDetails: "复制详情",
      copied: "已复制",
    },
  },
}

export function startupPageLabels(locale: MenuLocale) {
  return labels[locale]
}
