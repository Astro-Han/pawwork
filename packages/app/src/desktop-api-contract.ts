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

/** Connection state of one mobile-companion channel, as the renderer sees it. */
export type RemoteState = "disconnected" | "connecting" | "connected" | "degraded"

/** The chat platforms the bridge can connect. */
export type RemotePlatform = "telegram"

/** Masked status of one channel — never includes a secret. */
export type RemoteChannelStatus = {
  platform: RemotePlatform
  state: RemoteState
  /** The paired target (user or group), for display; null until known. */
  identity: { id: string; name: string } | null
  error: string | null
}

/**
 * Masked status of the whole bridge: one entry per platform that has a saved
 * account. Channels run concurrently and independently — one going `degraded`
 * leaves the others `connected`. A platform with no account simply has no entry
 * (the page renders it as a disconnected connect-target).
 */
export type RemoteStatus = { channels: RemoteChannelStatus[] }

/**
 * A step in a scan-to-connect pairing flow, pushed to the renderer as it
 * progresses. Secrets never appear here.
 *  - `awaitingBind` — the token is validated; now act from the phone (message the bot).
 *  - `captured` — the paired identity is ready for the user to approve.
 *  - `error` / `cancelled` — the flow ended.
 */
export type RemotePairingEvent =
  | { phase: "awaitingBind"; platform: RemotePlatform; hint: "message" }
  | { phase: "captured"; platform: RemotePlatform; identity: { id: string; name: string } }
  | { phase: "error"; platform: RemotePlatform; message: string }
  | { phase: "cancelled"; platform: RemotePlatform }

/** Options to begin pairing. Telegram needs a bot token. */
export type RemotePairingStart = { token?: string }

/**
 * Control surface for the mobile-companion bridge (connect a phone chat app to
 * this desktop's agent). Desktop/Electron only. Each platform pairs independently
 * and runs concurrently. Pairing is event-driven: `startPairing` kicks off the
 * flow, `onPairing` streams its steps (bind → captured), `confirmPairing` approves
 * the captured identity. The secret crosses only on `startPairing` (the Telegram
 * token); `confirmPairing` approves with no secret, and the stored credential
 * never returns over IPC.
 */
export type RemoteBridge = {
  getStatus(): Promise<RemoteStatus>
  onStatus(handler: (status: RemoteStatus) => void): () => void
  startPairing(platform: RemotePlatform, start?: RemotePairingStart): Promise<void>
  onPairing(handler: (event: RemotePairingEvent) => void): () => void
  confirmPairing(platform: RemotePlatform): Promise<void>
  cancelPairing(): Promise<void>
  disconnect(platform: RemotePlatform): Promise<void>
}
