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

/** Mobile-companion connection state, as the renderer sees it. */
export type RemoteState = "disconnected" | "connecting" | "connected" | "degraded"

/** Masked status of the mobile-companion bridge — never includes the bot token. */
export type RemoteStatus = {
  state: RemoteState
  platform: "telegram" | null
  identity: { userId: string; userName: string } | null
  error: string | null
}

/** The sender captured during pairing, for the user to approve before connecting. */
export type RemotePairingResult = {
  userId: string
  userName: string
  botUsername?: string
}

/**
 * Control surface for the mobile-companion bridge (connect a phone chat app to
 * this desktop's agent). Desktop/Electron only. Pairing is two steps: start
 * (paste token, then message the bot from your phone — resolves with the
 * captured sender, or null if cancelled) then confirm (approve that identity).
 * The token crosses this boundary only on `startPairing`; the main process holds
 * it from there, so `confirmPairing` approves the captured identity with no args
 * and never resends the secret.
 */
export type RemoteBridge = {
  getStatus(): Promise<RemoteStatus>
  startPairing(token: string): Promise<RemotePairingResult | null>
  cancelPairing(): Promise<void>
  confirmPairing(): Promise<void>
  disconnect(): Promise<void>
  onStatus(handler: (status: RemoteStatus) => void): () => void
}
