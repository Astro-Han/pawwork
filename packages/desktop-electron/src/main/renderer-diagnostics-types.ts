export const DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES = 20 * 1024 * 1024
export const DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS = 24 * 60 * 60 * 1000
export const SESSION_EXPORT_RENDERER_DIAGNOSTICS_MAX_BYTES = 1 * 1024 * 1024
export const GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES = 10 * 1024 * 1024
export const RENDERER_DIAGNOSTIC_EVENT_MAX_BYTES = 8 * 1024
export const DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_CHECK_MS = 60 * 1000
export const RENDERER_DIAGNOSTICS_RETENTION_TARGET_RATIO = 0.8

export type RendererDiagnosticsStatus =
  | "ok"
  | "missing"
  | "expired"
  | "truncated"
  | "corrupt"
  | "disabled"
  | "write_failed"

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

export type RendererDiagnosticEvent = {
  time: string
  monotonic_ms?: number
  level: "info" | "warn"
  "event.name": string
  app_launch_id: string
  window_id: string
  trace_id?: string
  route_session_id?: string
  visible_session_id?: string
  timeline_session_id?: string
  message_id?: string
  part_id?: string
  data: Record<string, string | number | boolean | null>
}

export type RendererDiagnosticsSlice = {
  status: RendererDiagnosticsStatus
  source: "renderer-diagnostics"
  generated_at: string
  events: RendererDiagnosticEvent[]
  summary: {
    event_count: number
    incident_count: number
    statuses: RendererDiagnosticsStatus[]
    omitted_event_count: number
    omitted_bytes: number
  }
}

export type RendererDiagnosticsExport = {
  schema_version: 1
  format: "pawwork-renderer-diagnostics"
  source: "renderer-diagnostics"
  generated_at: string
  diagnostics: {
    status: RendererDiagnosticsStatus
    event_count: number
    incident_count: number
    corrupt_line_count: number
    omitted_event_count: number
    omitted_bytes: number
  }
  events: RendererDiagnosticEvent[]
}

export type SanitizeContext = {
  appLaunchID: string
  now: () => Date
  windowID: number | string
}

export type RecorderOptions = {
  root: string
  appLaunchID: string
  maxBytes?: number
  retentionMs?: number
  retentionCheckIntervalMs?: number
  highFrequencyIntervalMs?: number
  disabled?: boolean
  now?: () => Date
}

export type RecordContext = {
  windowID: number | string
}

export type SliceInput = {
  sessionID?: string | null
  traceID?: string
  from?: Date
  to?: Date
  maxBytes: number
}

export type InternalSliceInput = SliceInput & {
  appLaunchID?: string
  windowID?: string | number
  now: Date
}
