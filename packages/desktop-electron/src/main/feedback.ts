import { homedir, userInfo } from "node:os"
import { dirname } from "node:path"
import type {
  DiagnosticsReviewContents,
  PrepareReportResult,
  ReportProblemInput,
  SubmitReportResult,
} from "@opencode-ai/app/desktop-api"
import {
  buildProblemReport,
  buildProblemReportSummary,
  DEFAULT_PROBLEM_REPORT_MAX_BYTES,
  defaultReportId,
  type ProblemReportDiagnostics,
  type SessionExport,
} from "./problem-report"
import { emptyRendererDiagnosticsSlice, type RendererDiagnosticsSlice } from "./renderer-diagnostics"
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
  openExternal: (url: string) => Promise<void> | void
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

/** A prepared-but-not-yet-submitted package, kept so reveal/submit can act on it. */
type PendingReport = {
  reportId: string
  path: string
  summary: string
}

/** Public surface of the feedback handler: prepare, then reveal and/or submit. */
export type FeedbackHandler = {
  prepareReport: (
    input?: FeedbackInput,
    contextOverride?: FeedbackContextOverride,
  ) => Promise<PrepareReportResult>
  revealReport: (reportId: string) => Promise<void>
  submitReport: (reportId: string) => Promise<SubmitReportResult>
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

// Exact local identifiers no regex can infer (home directory, OS username) — redacted verbatim
// from the report. Best-effort: userInfo() can throw on some platforms, so a failure just
// contributes no extra term rather than blocking the report.
function localRedactTerms(): string[] {
  const terms: string[] = []
  try {
    const home = homedir()
    if (home) terms.push(home)
  } catch {
    // ignore — no home term
  }
  try {
    const name = userInfo().username
    if (name) terms.push(name)
  } catch {
    // ignore — no username term
  }
  return terms
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

export function createFeedbackHandler(deps: FeedbackDeps): FeedbackHandler {
  let inFlight: { windowID?: number; rendererErrorKey: string; promise: Promise<PrepareReportResult> } | undefined
  let pending: PendingReport | undefined

  async function runPrepareReport(
    input: FeedbackInput,
    contextOverride?: FeedbackContextOverride,
  ): Promise<PrepareReportResult> {
    const context = deps.context?.(contextOverride)

    const id = defaultReportId()
    const generatedAt = new Date().toISOString()
    // Compute the exact runtime terms (home dir, OS username) once and share them across BOTH the
    // full report and the clipboard summary — the summary is the same outbound channel, so it must
    // scrub the same bare identifiers no regex can infer.
    const redactTerms = localRedactTerms()
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
          { reportId: id, generatedAt, maxBytes: DEFAULT_PROBLEM_REPORT_MAX_BYTES, redactTerms },
        )
        savedReport = await deps.saveReport({ reportId: id, generatedAt, markdown: report.markdown })
      } catch (error) {
        fullReportFailure = safeFailureReason(error)
      }
    }

    // The summary is the degraded fallback the renderer can copy when the package
    // file could not be written (e.g. Windows disk/permission), so the feedback
    // link never goes fully dead. Built regardless of whether the save succeeded.
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
      redactTerms,
    })

    if (!savedReport) {
      pending = undefined
      return { status: "failed", reason: fullReportFailure ?? "report_failed", summary }
    }

    // Prune older packages now that the new one is on disk. Preparation has no
    // other side effect — no clipboard copy, no reveal, no form. Those are the
    // user's explicit choices in the review dialog (revealReport / submitReport).
    try {
      await deps.cleanupReports(savedReport.path)
    } catch (error) {
      deps.onHandledError?.("problem report cleanup failed", error)
    }

    pending = { reportId: id, path: savedReport.path, summary }

    const contents: DiagnosticsReviewContents = {
      logLines: logTail ? logTail.split(/\r?\n/).filter((line) => line.length > 0).length : null,
      sessionMessages: sessionExport.status === "ok" ? sessionExport.messages.length : null,
      rendererEvents: rendererDiagnostics.events.length,
      rendererError: Boolean(input.rendererError),
    }

    return {
      status: "ready",
      reportId: id,
      fileName: savedReport.fileName,
      locationHint: savedReport.locationHint,
      hasForm: Boolean(deps.feedbackUrl),
      contents,
    }
  }

  async function prepareReport(
    input: FeedbackInput = {},
    contextOverride?: FeedbackContextOverride,
  ): Promise<PrepareReportResult> {
    // Dedupe only a re-entrant prepare for the SAME context (a rapid double-trigger from one window with
    // the same error). A different window or a different renderer error must get its OWN package — never
    // the in-flight one's reportId, or it could reveal/submit diagnostics generated from the wrong context.
    const windowID = contextOverride?.windowID
    const rendererErrorKey = JSON.stringify(input.rendererError ?? null)
    if (inFlight && inFlight.windowID === windowID && inFlight.rendererErrorKey === rendererErrorKey) {
      return inFlight.promise
    }
    const promise = runPrepareReport(input, contextOverride)
      .catch(async (error) => {
        try {
          await deps.onError?.(error)
        } catch (handlerError) {
          deps.onHandledError?.("report problem error handler failed", handlerError)
        }
        return { status: "failed", reason: "report_failed", summary: "" } satisfies PrepareReportResult
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = undefined
      })
    inFlight = { windowID, rendererErrorKey, promise }
    return promise
  }

  async function revealReport(reportId: string): Promise<void> {
    if (!pending || pending.reportId !== reportId) return
    const { path } = pending
    try {
      await deps.showItemInFolder(path)
    } catch (error) {
      deps.onHandledError?.("problem report reveal failed", error)
      try {
        const openPathError = await deps.openPath(dirname(path))
        if (typeof openPathError === "string" && openPathError.length > 0) throw new Error(openPathError)
      } catch (openPathError) {
        deps.onHandledError?.("problem report directory open failed", openPathError)
      }
    }
  }

  async function submitReport(reportId: string): Promise<SubmitReportResult> {
    // Act only on the package currently under review; a stale id (a newer
    // prepare replaced it) must not open the form, mirroring revealReport.
    if (!pending || pending.reportId !== reportId) return { status: "stale" }
    if (!deps.feedbackUrl) return { status: "no-form" }
    try {
      await deps.openExternal(deps.feedbackUrl)
      return { status: "opened" }
    } catch (error) {
      deps.onHandledError?.("feedback form open failed", error)
      return { status: "form-fallback", feedbackUrl: deps.feedbackUrl, summary: pending.summary }
    }
  }

  return { prepareReport, revealReport, submitReport }
}
