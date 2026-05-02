import { appendFile, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

export const DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES = 20 * 1024 * 1024
export const DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS = 24 * 60 * 60 * 1000
export const SESSION_EXPORT_RENDERER_DIAGNOSTICS_MAX_BYTES = 1 * 1024 * 1024
export const GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES = 10 * 1024 * 1024
export const RENDERER_DIAGNOSTIC_EVENT_MAX_BYTES = 8 * 1024

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

type SanitizeContext = {
  appLaunchID: string
  now: () => Date
  windowID: number | string
}

type RecorderOptions = {
  root: string
  appLaunchID: string
  maxBytes?: number
  retentionMs?: number
  highFrequencyIntervalMs?: number
  disabled?: boolean
  now?: () => Date
}

type RecordContext = {
  windowID: number | string
}

type SliceInput = {
  appLaunchID?: string
  windowID?: string | number
  sessionID?: string | null
  traceID?: string
  from?: Date
  to?: Date
  maxBytes: number
  now: Date
}

const eventDataFields = {
  "session.view.state": [
    "route_session_id",
    "visible_session_id",
    "timeline_session_id",
    "route_ready",
    "visible_ready",
    "transitioning",
    "message_count",
    "part_count",
    "history_more",
    "history_loading",
  ],
  "session.identity.transition": [
    "from_route_session_id",
    "to_route_session_id",
    "from_visible_session_id",
    "to_visible_session_id",
    "from_timeline_session_id",
    "to_timeline_session_id",
  ],
  "session.action.submit": [
    "action",
    "provider",
    "model",
    "endpoint_kind",
    "prompt_length",
    "image_count",
    "comment_count",
  ],
  "session.timeline.mount": ["rendered_count", "visible_first_message_id", "visible_last_message_id"],
  "session.timeline.unmount": ["rendered_count", "visible_first_message_id", "visible_last_message_id"],
  "session.timeline.visible": ["rendered_count", "visible_first_message_id", "visible_last_message_id"],
  "session.scroll.sample": [
    "scroll_top",
    "scroll_height",
    "client_height",
    "distance_from_bottom",
    "user_scrolled",
    "jump_button_visible",
    "visible_first_message_id",
    "visible_last_message_id",
  ],
  "session.layout.composer_dock": ["composer_height", "previous_composer_height", "scroll_top", "distance_from_bottom"],
  "session.data.refresh": ["phase", "message_count", "part_count", "duration_ms", "cache_present"],
  "renderer.perf.sample": [
    "fps",
    "frame_gap_ms",
    "jank_count",
    "long_task_max_ms",
    "long_task_block_ms",
    "cls",
    "heap_used_mb",
  ],
  "renderer.visibility": ["visibility"],
  "incident.session_scroll_jump_to_top": ["scroll_top", "distance_from_bottom", "client_height", "user_scrolled"],
  "incident.session_timeline_remount": ["timeline_mount_count", "timeline_unmount_count"],
  "incident.session_visible_messages_cleared": ["before_count", "during_count", "after_count"],
  "incident.session_layout_shift": ["cls", "phase"],
  "incident.session_jank_burst": ["long_task_max_ms", "frame_gap_ms", "phase"],
} as const

const highFrequencyEvents = new Set(["session.scroll.sample", "renderer.perf.sample"])

function isAllowedEventName(name: string): name is keyof typeof eventDataFields {
  return Object.hasOwn(eventDataFields, name)
}

function stringField(value: unknown, limit = 160) {
  if (typeof value !== "string") return undefined
  const next = value.replace(/\s+/g, " ").trim()
  if (!next) return undefined
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(next)) return undefined
  if (/\b[a-z0-9.-]+\.[a-z]{2,}(?:\/|\?|:|$)/i.test(next)) return undefined
  if (/token=|key=|secret=|authorization/i.test(next)) return undefined
  return next.length > limit ? next.slice(0, limit) : next
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanField(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function safeJsonBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function jsonBytes(value: unknown) {
  const bytes = safeJsonBytes(value)
  return Number.isFinite(bytes) ? bytes : 0
}

function safeDataValue(value: unknown) {
  const string = stringField(value)
  if (string !== undefined) return string
  const number = numberField(value)
  if (number !== undefined) return number
  const boolean = booleanField(value)
  if (boolean !== undefined) return boolean
  if (value === null) return null
  return undefined
}

function sanitizeData(name: keyof typeof eventDataFields, data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {}
  const input = data as Record<string, unknown>
  const output: Record<string, string | number | boolean | null> = {}
  for (const key of eventDataFields[name]) {
    if (!(key in input)) continue
    const value = safeDataValue(input[key])
    if (value !== undefined) output[key] = value
  }
  return output
}

export function sanitizeRendererDiagnosticEvent(
  input: unknown,
  context: SanitizeContext,
): RendererDiagnosticEvent | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const diagnostic = input as RendererDiagnosticInput
  if (!isAllowedEventName(diagnostic.name)) return undefined
  if (safeJsonBytes(diagnostic) > RENDERER_DIAGNOSTIC_EVENT_MAX_BYTES) return undefined
  const event: RendererDiagnosticEvent = {
    time: context.now().toISOString(),
    level: diagnostic.level === "warn" ? "warn" : "info",
    "event.name": diagnostic.name,
    app_launch_id: context.appLaunchID,
    window_id: String(context.windowID),
    data: sanitizeData(diagnostic.name, diagnostic.data),
  }
  const monotonic = numberField(diagnostic.monotonic_ms)
  if (monotonic !== undefined) event.monotonic_ms = monotonic
  const traceID = stringField(diagnostic.trace_id, 80)
  if (traceID) event.trace_id = traceID
  const routeID = stringField(diagnostic.route_session_id, 120)
  if (routeID) event.route_session_id = routeID
  const visibleID = stringField(diagnostic.visible_session_id, 120)
  if (visibleID) event.visible_session_id = visibleID
  const timelineID = stringField(diagnostic.timeline_session_id, 120)
  if (timelineID) event.timeline_session_id = timelineID
  const messageID = stringField(diagnostic.message_id, 120)
  if (messageID) event.message_id = messageID
  const partID = stringField(diagnostic.part_id, 120)
  if (partID) event.part_id = partID
  return event
}

function parseEventLine(line: string): RendererDiagnosticEvent | undefined {
  try {
    const value = JSON.parse(line) as RendererDiagnosticEvent
    if (!value || typeof value !== "object") return undefined
    if (typeof value.time !== "string") return undefined
    if (typeof value["event.name"] !== "string") return undefined
    if (typeof value.app_launch_id !== "string") return undefined
    if (typeof value.window_id !== "string") return undefined
    if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) return undefined
    return value
  } catch {
    return undefined
  }
}

function eventTime(event: RendererDiagnosticEvent) {
  const time = Date.parse(event.time)
  return Number.isFinite(time) ? time : 0
}

function eventMatchesSession(event: RendererDiagnosticEvent, sessionID: string) {
  if (event.route_session_id === sessionID) return true
  if (event.visible_session_id === sessionID) return true
  if (event.timeline_session_id === sessionID) return true
  const data = event.data
  return (
    data.from_route_session_id === sessionID ||
    data.to_route_session_id === sessionID ||
    data.from_visible_session_id === sessionID ||
    data.to_visible_session_id === sessionID ||
    data.from_timeline_session_id === sessionID ||
    data.to_timeline_session_id === sessionID
  )
}

function isIncident(event: RendererDiagnosticEvent) {
  return event["event.name"].startsWith("incident.")
}

export function emptyRendererDiagnosticsSlice(status: RendererDiagnosticsStatus, now: Date): RendererDiagnosticsSlice {
  return {
    status,
    source: "renderer-diagnostics",
    generated_at: now.toISOString(),
    events: [],
    summary: {
      event_count: 0,
      incident_count: 0,
      statuses: [status],
      omitted_event_count: 0,
      omitted_bytes: 0,
    },
  }
}

function isProtectedSliceContext(event: RendererDiagnosticEvent) {
  return isIncident(event) || event["event.name"] === "session.identity.transition"
}

function capEvents(events: RendererDiagnosticEvent[], maxBytes: number) {
  let selected = events.slice()
  let omitted = 0
  while (selected.length > 0 && jsonBytes(selected) > maxBytes) {
    const removable = selected.findIndex((event) => !isProtectedSliceContext(event))
    const index = removable >= 0 ? removable : 0
    selected.splice(index, 1)
    omitted++
  }
  return {
    events: selected,
    omittedEventCount: omitted,
    omittedBytes: Math.max(0, jsonBytes(events) - jsonBytes(selected)),
  }
}

export function selectRendererDiagnosticsSlice(
  inputEvents: RendererDiagnosticEvent[],
  input: SliceInput,
): RendererDiagnosticsSlice {
  const windowID = input.windowID === undefined ? undefined : String(input.windowID)
  const from = input.from?.getTime() ?? input.now.getTime() - 5 * 60 * 1000
  const to = input.to?.getTime() ?? input.now.getTime() + 60 * 1000
  const events = inputEvents
    .filter((event) => {
      const time = eventTime(event)
      if (time < from || time > to) return false
      if (input.appLaunchID && event.app_launch_id !== input.appLaunchID) return false
      if (windowID && event.window_id !== windowID) return false
      if (input.traceID && event.trace_id === input.traceID) return true
      if (input.sessionID && eventMatchesSession(event, input.sessionID)) return true
      return !input.sessionID && !input.traceID
    })
    .sort((a, b) => eventTime(a) - eventTime(b))
  const capped = capEvents(events, input.maxBytes)
  const incidentCount = capped.events.filter(isIncident).length
  return {
    status: capped.omittedEventCount > 0 ? "truncated" : "ok",
    source: "renderer-diagnostics",
    generated_at: input.now.toISOString(),
    events: capped.events,
    summary: {
      event_count: capped.events.length,
      incident_count: incidentCount,
      statuses: capped.omittedEventCount > 0 ? ["truncated"] : ["ok"],
      omitted_event_count: capped.omittedEventCount,
      omitted_bytes: capped.omittedBytes,
    },
  }
}

export function rendererDiagnosticsRoot(userDataPath: string) {
  return join(userDataPath, "diagnostics")
}

export function rendererDiagnosticsPath(root: string) {
  return join(root, "renderer-diagnostics.jsonl")
}

export async function exportRendererDiagnosticsLog(input: {
  path: string
  destination: string
  maxBytes?: number
}) {
  const maxBytes = input.maxBytes ?? GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES
  await copyFile(input.path, input.destination)
  let content = await readFile(input.destination, "utf8")
  while (Buffer.byteLength(content, "utf8") > maxBytes) {
    const nextLine = content.indexOf("\n")
    if (nextLine < 0) {
      content = ""
      break
    }
    content = content.slice(nextLine + 1)
  }
  await writeFile(input.destination, content, "utf8")
}

export function createRendererDiagnosticsRecorder(options: RecorderOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES
  const retentionMs = options.retentionMs ?? DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS
  const highFrequencyIntervalMs = options.highFrequencyIntervalMs ?? 250
  const now = options.now ?? (() => new Date())
  const path = rendererDiagnosticsPath(options.root)
  const lastHighFrequency = new Map<string, number>()
  let writeFailed = false

  const readEventReport = async () => {
    try {
      const content = await readFile(path, "utf8")
      const lines = content.split(/\r?\n/).filter(Boolean)
      const events: RendererDiagnosticEvent[] = []
      let corruptLineCount = 0
      for (const line of lines) {
        const event = parseEventLine(line)
        if (event) events.push(event)
        else corruptLineCount++
      }
      return { status: "ok" as const, events, corruptLineCount }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "missing" as const, events: [], corruptLineCount: 0 }
      }
      return { status: "corrupt" as const, events: [], corruptLineCount: 1 }
    }
  }

  const readEvents = async () => (await readEventReport()).events

  const flushRetention = async () => {
    const events = await readEvents()
    const cutoff = now().getTime() - retentionMs
    const retained = events.filter((event) => eventTime(event) >= cutoff)
    let content = retained.map((event) => JSON.stringify(event)).join("\n")
    if (content) content += "\n"
    while (Buffer.byteLength(content, "utf8") > maxBytes && retained.length > 0) {
      retained.shift()
      content = retained.map((event) => JSON.stringify(event)).join("\n")
      if (content) content += "\n"
    }
    await mkdir(options.root, { recursive: true })
    const temp = join(options.root, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temp, content, "utf8")
    await rename(temp, path).catch(async (error) => {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    })
  }

  const record = async (input: unknown, context: RecordContext) => {
    try {
      const sanitized = sanitizeRendererDiagnosticEvent(input, {
        appLaunchID: options.appLaunchID,
        now,
        windowID: context.windowID,
      })
      if (!sanitized) return { ok: false as const, reason: "dropped" as const }
      if (highFrequencyEvents.has(sanitized["event.name"])) {
        const key = `${sanitized.window_id}:${sanitized["event.name"]}`
        const current = Date.now()
        const previous = lastHighFrequency.get(key)
        if (previous !== undefined && current - previous < highFrequencyIntervalMs) {
          return { ok: false as const, reason: "rate_limited" as const }
        }
        lastHighFrequency.set(key, current)
      }
      await mkdir(options.root, { recursive: true })
      await appendFile(path, `${JSON.stringify(sanitized)}\n`, "utf8")
      await flushRetention()
      return { ok: true as const }
    } catch {
      writeFailed = true
      return { ok: false as const, reason: "write_failed" as const }
    }
  }

  const slice = async (input: Omit<SliceInput, "appLaunchID" | "now">) => {
    if (options.disabled) return emptyRendererDiagnosticsSlice("disabled", now())
    if (writeFailed) return emptyRendererDiagnosticsSlice("write_failed", now())
    const report = await readEventReport()
    if (report.status === "missing") return emptyRendererDiagnosticsSlice("missing", now())
    if (report.status === "corrupt" || (report.events.length === 0 && report.corruptLineCount > 0)) {
      return emptyRendererDiagnosticsSlice("corrupt", now())
    }
    const events = report.events
    if (events.length === 0) return emptyRendererDiagnosticsSlice("missing", now())
    const windowID = input.windowID === undefined ? undefined : String(input.windowID)
    const hasMatchingIdentity = events.some((event) => {
      if (event.app_launch_id !== options.appLaunchID) return false
      if (windowID && event.window_id !== windowID) return false
      if (input.traceID && event.trace_id === input.traceID) return true
      if (input.sessionID && eventMatchesSession(event, input.sessionID)) return true
      return !input.sessionID && !input.traceID
    })
    const slice = selectRendererDiagnosticsSlice(events, {
      ...input,
      appLaunchID: options.appLaunchID,
      now: now(),
    })
    if (slice.events.length === 0) return emptyRendererDiagnosticsSlice(hasMatchingIdentity ? "expired" : "missing", now())
    return slice
  }

  return {
    path,
    record,
    flushRetention,
    readEvents,
    readEventReport,
    slice,
  }
}
