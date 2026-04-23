import { dirname } from "node:path"
import {
  buildProblemReport,
  buildProblemReportSummary,
  DEFAULT_PROBLEM_REPORT_MAX_BYTES,
  defaultReportId,
  type ProblemReportDiagnostics,
  type SessionExport,
} from "./problem-report"
import type { MenuLocale } from "./menu-labels"
import { errorMessage } from "./error"

type SavedReport = {
  path: string
  fileName: string
  locationHint: string
}

type SaveReportInput = {
  reportId: string
  generatedAt: string
  markdown: string
}

type FeedbackDeps = {
  feedbackUrl: string
  reportRoot: string
  context?: () => unknown
  confirm: (context?: unknown) => Promise<boolean>
  copy: (value: string) => Promise<void> | void
  openExternal: (url: string) => Promise<void> | void
  showFeedbackUrlFallback: (url: string) => Promise<void> | void
  showItemInFolder: (path: string) => Promise<void> | void
  openPath: (path: string) => Promise<string | void> | string | void
  saveReport: (input: SaveReportInput) => Promise<SavedReport>
  cleanupReports: (currentPath: string) => Promise<void> | void
  sessionExportTimeoutMs: number
  diagnostics: (context?: unknown) => ProblemReportDiagnostics
  logTail: () => string
  sessionExport: (context?: unknown, signal?: AbortSignal) => Promise<SessionExport>
  onHandledError?: (message: string, error: unknown) => void
  onError?: (error: unknown) => Promise<void> | void
}

export function feedbackDialogLabels(locale: MenuLocale) {
  const labels = {
    en: {
      title: "Prepare problem report?",
      message:
        "PawWork will copy a short summary to your clipboard, save a full problem report file locally, and open the feedback form.\n\nUpload the full problem report file if the form asks for details. You can delete the local full report file after submission.",
      confirm: "Copy summary and open form",
      cancel: "Cancel",
      failedTitle: "Problem Report Failed",
      failedMessage: "Could not prepare the problem report. You can try Report a Problem again.",
      formOpenFailedTitle: "Feedback Form Did Not Open",
      formOpenFailedMessage:
        "PawWork prepared the problem report, but could not open the feedback form. Open this URL manually to finish submitting feedback.",
    },
    zh: {
      title: "准备问题报告？",
      message:
        "PawWork 会复制一份简短摘要到剪贴板，保存完整问题报告文件到本地，并打开反馈表单。\n\n如果表单需要更多细节，可以上传完整问题报告文件。提交后可以删除本地完整报告文件。",
      confirm: "复制摘要并打开表单",
      cancel: "取消",
      failedTitle: "问题报告失败",
      failedMessage: "无法准备问题报告。你可以重新点击“报告问题”再试一次。",
      formOpenFailedTitle: "反馈表单未打开",
      formOpenFailedMessage: "PawWork 已准备好问题报告，但无法打开反馈表单。请手动打开这个链接继续提交反馈。",
    },
  } satisfies Record<
    MenuLocale,
    {
      title: string
      message: string
      confirm: string
      cancel: string
      failedTitle: string
      failedMessage: string
      formOpenFailedTitle: string
      formOpenFailedMessage: string
    }
  >

  // Runtime fallback for unexpected locale values crossing process boundaries,
  // such as malformed IPC payloads or manually edited config.
  return labels[locale] ?? labels.en
}

function safeFailureReason(error: unknown) {
  const message = errorMessage(error)
  if (/timed out/i.test(message)) return "timeout"
  if (/EACCES|EPERM/i.test(message)) return "permission_denied"
  if (/ENOSPC/i.test(message)) return "disk_full"
  if (/ENOENT/i.test(message)) return "path_unavailable"
  return "report_failed"
}

function fallbackDiagnostics(): ProblemReportDiagnostics {
  return {
    appVersion: "unknown",
    channel: "unknown",
    packaged: false,
    updaterEnabled: false,
    platform: process.platform,
    osVersion: "unknown",
    arch: process.arch,
    electronVersion: process.versions.electron ?? "unknown",
    locale: "en",
    route: "/",
    directory: null,
    sessionID: null,
    logPath: "",
  }
}

function recentKeyErrors(logTail: string) {
  return logTail
    .split(/\r?\n/)
    .filter((line) => /\b(error|warn|warning|failed|exception)\b/i.test(line))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-10)
}

async function sessionExportWithTimeout(deps: FeedbackDeps, context: unknown) {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      deps.sessionExport(context, controller.signal),
      new Promise<SessionExport>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("session export timed out"))
          controller.abort()
        }, deps.sessionExportTimeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export function createFeedbackHandler(deps: FeedbackDeps) {
  let inFlight: Promise<void> | undefined

  async function runReportProblem() {
    if (!deps.feedbackUrl) return
    const context = deps.context?.()
    const confirmed = await deps.confirm(context)
    if (!confirmed) return

    const id = defaultReportId()
    const generatedAt = new Date().toISOString()
    let diagnostics: ProblemReportDiagnostics
    let logTail = ""
    let sessionExport: SessionExport = { status: "none" }
    let savedReport: SavedReport | undefined
    let fullReportFailure: string | undefined

    try {
      diagnostics = deps.diagnostics(context)
    } catch (error) {
      diagnostics = fallbackDiagnostics()
      fullReportFailure = safeFailureReason(error)
    }

    try {
      logTail = deps.logTail()
    } catch (error) {
      fullReportFailure ??= safeFailureReason(error)
    }

    try {
      sessionExport = await sessionExportWithTimeout(deps, context)
    } catch (error) {
      sessionExport = { status: "failed", error: errorMessage(error) }
    }

    if (!fullReportFailure) {
      try {
        const report = buildProblemReport(
          { diagnostics, logTail, sessionExport },
          { reportId: id, generatedAt, maxBytes: DEFAULT_PROBLEM_REPORT_MAX_BYTES },
        )
        savedReport = await deps.saveReport({ reportId: id, generatedAt, markdown: report.markdown })
      } catch (error) {
        fullReportFailure = safeFailureReason(error)
      }
    }

    const summary = buildProblemReportSummary({
      reportId: id,
      generatedAt,
      diagnostics,
      reportFileName: savedReport?.fileName ?? null,
      reportLocationHint: savedReport?.locationHint ?? null,
      fullReportStatus: savedReport ? "ready" : "failed",
      failureReason: fullReportFailure,
      recentErrors: recentKeyErrors(logTail),
    })

    await deps.copy(summary)

    if (savedReport) {
      try {
        await deps.showItemInFolder(savedReport.path)
      } catch (error) {
        deps.onHandledError?.("problem report reveal failed", error)
        try {
          const openPathError = await deps.openPath(dirname(savedReport.path))
          if (typeof openPathError === "string" && openPathError.length > 0) throw new Error(openPathError)
        } catch (openPathError) {
          deps.onHandledError?.("problem report directory open failed", openPathError)
        }
      }
      try {
        await deps.cleanupReports(savedReport.path)
      } catch (error) {
        deps.onHandledError?.("problem report cleanup failed", error)
      }
    }

    try {
      await deps.openExternal(deps.feedbackUrl)
    } catch (error) {
      deps.onHandledError?.("feedback form open failed", error)
      try {
        await deps.showFeedbackUrlFallback(deps.feedbackUrl)
      } catch (fallbackError) {
        deps.onHandledError?.("feedback form fallback failed", fallbackError)
      }
    }
  }

  return async function reportProblem() {
    if (inFlight) return inFlight
    inFlight = runReportProblem()
      .catch(async (error) => {
        await deps.onError?.(error)
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }
}
