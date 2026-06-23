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
  rendererError?: RendererErrorDetails
}

/**
 * What the prepared diagnostics package contains, surfaced in the review dialog
 * so the user sees the real shape before sharing. Counts are `null` when that
 * component is absent or failed to collect (a missing count reads as "not
 * included", never as zero diagnostic value). `environment` is always present
 * when the package is ready, so it carries no count.
 */
export type DiagnosticsReviewContents = {
  logLines: number | null
  sessionMessages: number | null
  rendererEvents: number | null
  rendererError: boolean
}

/**
 * Result of preparing (generating + redacting + saving) a diagnostics package.
 * Preparation has no side effects beyond writing the local file — it never
 * copies to the clipboard, reveals the file, or opens the feedback form. Those
 * are explicit follow-up actions the user takes from the review dialog
 * (`revealReport` / `submitReport`).
 */
export type PrepareReportResult =
  | {
      status: "ready"
      reportId: string
      fileName: string
      locationHint: string
      hasForm: boolean
      contents: DiagnosticsReviewContents
    }
  | { status: "failed"; reason: string; summary: string }

/**
 * Result of opening the external feedback form after review.
 *  - `opened` — the form opened in the browser.
 *  - `form-fallback` — the form could not open; the URL and a redacted summary
 *    are returned so the dialog can offer the URL plus an optional copy.
 *  - `no-form` — this build has no feedback form configured (package-only).
 *  - `stale` — the reportId is not the pending package (a newer prepare replaced
 *    it); submission is a no-op so a stale review surface cannot act.
 */
export type SubmitReportResult =
  | { status: "opened" }
  | { status: "form-fallback"; feedbackUrl: string; summary: string }
  | { status: "no-form" }
  | { status: "stale" }

/**
 * Result of revealing the prepared package in the OS file manager. Reveal can
 * fail inside the main process (the OS handler declines) where the renderer
 * cannot observe it, so the outcome is reported back explicitly.
 *  - `revealed` — the file was highlighted in its folder.
 *  - `opened-directory` — highlighting failed; the containing folder was opened instead.
 *  - `stale` — the reportId is not the pending package (a newer prepare replaced it).
 *  - `failed` — neither reveal nor the directory fallback could open anything.
 */
export type RevealReportResult =
  | { status: "revealed" }
  | { status: "opened-directory" }
  | { status: "stale" }
  | { status: "failed" }

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
export type RemotePlatform = "telegram" | "wechat"

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
 *  - `qr` — a QR image (PNG data URL) to scan from the phone; re-emitted if the
 *    code expires. WeChat sign-in. The image is rendered main-side so the renderer
 *    just shows it.
 *  - `awaitingBind` — the token is validated; now act from the phone (message the bot).
 *  - `captured` — the paired identity is ready (Telegram: user approves; WeChat: the
 *    scan+confirm already authorized, so the renderer approves automatically).
 *  - `error` / `cancelled` — the flow ended.
 */
export type RemotePairingEvent =
  | { phase: "qr"; platform: RemotePlatform; image: string }
  | { phase: "awaitingBind"; platform: RemotePlatform; hint: "message" }
  | { phase: "captured"; platform: RemotePlatform; identity: { id: string; name: string } }
  | { phase: "error"; platform: RemotePlatform; message: string }
  | { phase: "cancelled"; platform: RemotePlatform }

/** Options to begin pairing. Telegram needs a bot token; WeChat needs nothing (QR). */
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
