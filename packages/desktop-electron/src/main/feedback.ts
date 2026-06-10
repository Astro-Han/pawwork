import { dirname } from "node:path"
import type { ReportProblemInput, ReportProblemResult } from "@opencode-ai/app/desktop-api"
import {
  buildProblemReport,
  buildProblemReportSummary,
  DEFAULT_PROBLEM_REPORT_MAX_BYTES,
  defaultReportId,
  type ProblemReportDiagnostics,
  type SessionExport,
} from "./problem-report"
import { emptyRendererDiagnosticsSlice, type RendererDiagnosticsSlice } from "./renderer-diagnostics"
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

type FeedbackContextOverride = {
  windowID?: number
}

type FeedbackDeps = {
  feedbackUrl: string
  reportRoot: string
  context?: (override?: FeedbackContextOverride) => unknown
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
  rendererDiagnostics: (context?: unknown) => Promise<RendererDiagnosticsSlice>
  onHandledError?: (message: string, error: unknown) => void
  onError?: (error: unknown) => Promise<void> | void
}

type FeedbackInput = ReportProblemInput
export type FeedbackResult = ReportProblemResult

export function feedbackDialogLabels(locale: MenuLocale, options: { withForm?: boolean } = {}) {
  const withForm = options.withForm ?? true
  const labels = {
    en: {
      title: "Prepare diagnostics package?",
      message: withForm
        ? "PawWork will save one diagnostics package locally, copy a short summary, and open the feedback form.\n\nThe package can include session content, renderer diagnostics, app logs, local paths, and environment information. Review it before uploading. You can delete the local package after submission."
        : "PawWork will save one diagnostics package locally and copy a short summary.\n\nThe package can include session content, renderer diagnostics, app logs, local paths, and environment information. Review it before sharing. This build does not have a feedback form configured.",
      confirm: withForm ? "Prepare package and open form" : "Prepare package",
      cancel: "Cancel",
      failedTitle: "Diagnostics Package Failed",
      failedMessage: "Could not prepare the diagnostics package. You can try preparing it again.",
      formOpenFailedTitle: "Feedback Form Did Not Open",
      formOpenFailedMessage:
        "PawWork prepared the diagnostics package, but could not open the feedback form. Open this URL manually to finish submitting feedback.",
    },
    zh: {
      title: "准备诊断包？",
      message: withForm
        ? "应用会在本地保存一份诊断包，复制简短摘要，并打开反馈表单。\n\n诊断包可能包含会话内容、界面诊断、应用日志、本地路径和环境信息。上传前可以先检查，提交后也可以删除本地诊断包。"
        : "应用会在本地保存一份诊断包，并复制简短摘要。\n\n诊断包可能包含会话内容、界面诊断、应用日志、本地路径和环境信息。分享前可以先检查。当前构建没有配置反馈表单。",
      confirm: withForm ? "准备诊断包并打开表单" : "准备诊断包",
      cancel: "取消",
      failedTitle: "诊断包准备失败",
      failedMessage: "无法准备诊断包。你可以重新准备一次。",
      formOpenFailedTitle: "反馈表单未打开",
      formOpenFailedMessage: "诊断包已准备好，但无法打开反馈表单。请手动打开这个链接继续提交反馈。",
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

async function rendererDiagnosticsWithTimeout(deps: FeedbackDeps, context: unknown) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      deps.rendererDiagnostics(context),
      new Promise<RendererDiagnosticsSlice>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("renderer diagnostics timed out"))
        }, deps.sessionExportTimeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export function createFeedbackHandler(deps: FeedbackDeps) {
  let inFlight: Promise<FeedbackResult> | undefined

  async function runReportProblem(
    input: FeedbackInput = {},
    contextOverride?: FeedbackContextOverride,
  ): Promise<FeedbackResult> {
    const context = deps.context?.(contextOverride)
    const needsConfirm = input.confirm ?? true
    if (needsConfirm) {
      const confirmed = await deps.confirm(context)
      if (!confirmed) {
        return { status: "cancelled", summaryCopied: false, feedbackOpened: false, fullReport: { status: "none" } }
      }
    }

    const id = defaultReportId()
    const generatedAt = new Date().toISOString()
    let diagnostics: ProblemReportDiagnostics
    let logTail = ""
    let sessionExport: SessionExport = { status: "none" }
    let rendererDiagnostics: RendererDiagnosticsSlice = emptyRendererDiagnosticsSlice("missing", new Date(generatedAt))
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

    try {
      rendererDiagnostics = await rendererDiagnosticsWithTimeout(deps, context)
    } catch (error) {
      deps.onHandledError?.("renderer diagnostics slice failed", error)
      rendererDiagnostics = emptyRendererDiagnosticsSlice("write_failed", new Date(generatedAt))
    }

    if (!fullReportFailure) {
      try {
        const report = buildProblemReport(
          { diagnostics, logTail, sessionExport, rendererDiagnostics, rendererError: input.rendererError },
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
      rendererDiagnostics,
      rendererError: input.rendererError,
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

    if (!deps.feedbackUrl) {
      return {
        status: "package-only",
        summaryCopied: true,
        feedbackOpened: false,
        fullReport: savedReport
          ? { status: "ready", fileName: savedReport.fileName, locationHint: savedReport.locationHint }
          : { status: "failed" },
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
      return {
        status: "form-fallback",
        summaryCopied: true,
        feedbackOpened: false,
        feedbackUrl: deps.feedbackUrl,
        fullReport: savedReport
          ? { status: "ready", fileName: savedReport.fileName, locationHint: savedReport.locationHint }
          : { status: "failed" },
      }
    }

    return savedReport
      ? {
          status: "ready",
          summaryCopied: true,
          feedbackOpened: true,
          fullReport: { status: "ready", fileName: savedReport.fileName, locationHint: savedReport.locationHint },
        }
      : {
          status: "summary-only",
          summaryCopied: true,
          feedbackOpened: true,
          fullReport: { status: "failed" },
        }
  }

  return async function reportProblem(
    input?: FeedbackInput,
    contextOverride?: FeedbackContextOverride,
  ): Promise<FeedbackResult> {
    if (inFlight) return inFlight
    const next = runReportProblem(input, contextOverride)
      .catch(async (error) => {
        try {
          await deps.onError?.(error)
        } catch (handlerError) {
          deps.onHandledError?.("report problem error handler failed", handlerError)
        }
        return {
          status: "failed",
          summaryCopied: false,
          feedbackOpened: false,
          fullReport: { status: "failed" },
        } satisfies FeedbackResult
      })
      .finally(() => {
        inFlight = undefined
      })
    inFlight = next
    return next
  }
}
