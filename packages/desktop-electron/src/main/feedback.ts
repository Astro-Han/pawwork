import { buildProblemReport, type ProblemReportDiagnostics, type SessionExport } from "./problem-report"
import type { MenuLocale } from "./menu-labels"
import { errorMessage } from "./error"

type FeedbackDeps = {
  feedbackUrl: string
  context?: () => unknown
  confirm: (context?: unknown) => Promise<boolean>
  copy: (value: string) => Promise<void> | void
  openExternal: (url: string) => Promise<void> | void
  diagnostics: (context?: unknown) => ProblemReportDiagnostics
  logTail: () => string
  sessionExport: (context?: unknown) => Promise<SessionExport>
  onError?: (error: unknown) => Promise<void> | void
}

export function feedbackDialogLabels(locale: MenuLocale) {
  const labels = {
    en: {
      title: "Copy problem report?",
      message:
        "PawWork will copy a problem report to your clipboard and open the feedback form.\n\nThe report may include app diagnostics, recent app logs, current session messages, tool output, file names, paths that include your system username, and file snippets. Review it before submitting.",
      confirm: "Copy report and open form",
      cancel: "Cancel",
      failedTitle: "Problem Report Failed",
      failedMessage: "Could not copy the report or open the feedback form.",
    },
    zh: {
      title: "复制问题报告？",
      message:
        "PawWork 会复制一份问题报告到剪贴板，并打开反馈表单。\n\n报告可能包含应用诊断信息、最近应用日志、当前会话消息、工具输出、文件名、包含系统用户名的路径和文件片段。提交前请先检查。",
      confirm: "复制报告并打开表单",
      cancel: "取消",
      failedTitle: "问题报告失败",
      failedMessage: "无法复制报告或打开反馈表单。",
    },
  } satisfies Record<
    MenuLocale,
    { title: string; message: string; confirm: string; cancel: string; failedTitle: string; failedMessage: string }
  >

  // Runtime fallback for unexpected locale values crossing process boundaries,
  // such as malformed IPC payloads or manually edited config.
  return labels[locale] ?? labels.en
}

export function createFeedbackHandler(deps: FeedbackDeps) {
  return async function reportProblem() {
    try {
      if (!deps.feedbackUrl) return
      const context = deps.context?.()
      const confirmed = await deps.confirm(context)
      if (!confirmed) return

      let sessionExport: SessionExport
      try {
        sessionExport = await deps.sessionExport(context)
      } catch (error) {
        sessionExport = { status: "failed", error: errorMessage(error) }
      }

      const report = buildProblemReport({
        diagnostics: deps.diagnostics(context),
        logTail: deps.logTail(),
        sessionExport,
      })

      await deps.copy(report.markdown)
      await deps.openExternal(deps.feedbackUrl)
    } catch (error) {
      await deps.onError?.(error)
    }
  }
}
