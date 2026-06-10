export type AboutInfo = {
  version: string
  electronVersion: string
  chromeVersion: string
  buildSha: string
}

type UpdateFailureReason = "check" | "download" | "metadata" | "cache"

export type UpdateInfo =
  | { updateAvailable: false; status: "disabled" | "none" | "busy"; version?: undefined }
  | { updateAvailable: true; status: "ready"; version: string }
  | { updateAvailable: false; status: "failed"; reason: UpdateFailureReason; message: string; version?: undefined }

export type RendererErrorDetails = {
  summary: string
  details: string
}

export type ReportProblemInput = {
  confirm?: boolean
  rendererError?: RendererErrorDetails
}

export type ReportProblemResult =
  | {
      status: "ready"
      summaryCopied: true
      feedbackOpened: true
      fullReport: { status: "ready"; fileName: string; locationHint: string }
    }
  | {
      status: "summary-only"
      summaryCopied: true
      feedbackOpened: true
      fullReport: { status: "failed" }
    }
  | {
      status: "form-fallback"
      summaryCopied: true
      feedbackOpened: false
      feedbackUrl: string
      fullReport:
        | { status: "ready"; fileName: string; locationHint: string }
        | { status: "failed" }
    }
  | {
      status: "package-only"
      summaryCopied: true
      feedbackOpened: false
      fullReport:
        | { status: "ready"; fileName: string; locationHint: string }
        | { status: "failed" }
    }
  | { status: "cancelled"; summaryCopied: false; feedbackOpened: false; fullReport: { status: "none" } }
  | { status: "unavailable"; summaryCopied: false; feedbackOpened: false; fullReport: { status: "none" } }
  | { status: "failed"; summaryCopied: false; feedbackOpened: false; fullReport: { status: "failed" } }

export type RendererDiagnosticInput = {
  name: string
  level?: "info" | "warn"
  monotonic_ms?: number
  trace_id?: string
  route_session_id?: string
  visible_session_id?: string
  timeline_session_id?: string
  message_id?: string
  part_id?: string
  data?: Record<string, unknown>
}

export type RendererDiagnosticsExportResult = { ok: true; path: string } | { ok: false; error: string }

export type WebSearchStatus = {
  source: "saved" | "env" | "anonymous"
  configured: boolean
  needsAttention: boolean
  quotaExceeded: boolean
}
