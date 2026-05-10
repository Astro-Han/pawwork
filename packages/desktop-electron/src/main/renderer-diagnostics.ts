import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

export const DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES = 20 * 1024 * 1024
export const DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS = 24 * 60 * 60 * 1000
export const SESSION_EXPORT_RENDERER_DIAGNOSTICS_MAX_BYTES = 1 * 1024 * 1024
export const GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES = 10 * 1024 * 1024
export const RENDERER_DIAGNOSTIC_EVENT_MAX_BYTES = 8 * 1024
const DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_CHECK_MS = 60 * 1000

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
  retentionCheckIntervalMs?: number
  highFrequencyIntervalMs?: number
  disabled?: boolean
  now?: () => Date
}

type RecordContext = {
  windowID: number | string
}

type SliceInput = {
  sessionID?: string | null
  traceID?: string
  from?: Date
  to?: Date
  maxBytes: number
}

type InternalSliceInput = SliceInput & {
  appLaunchID?: string
  windowID?: string | number
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
  "session.timeline.scroll_controller": [
    "mode_before",
    "mode_after",
    "intent_type",
    "intent_source",
    "observation_type",
    "accepted",
    "recovery",
    "reason",
    "anchor_kind",
    "anchor_message_id",
    "submit_origin_mode",
    "near_top",
    "near_bottom",
    "near_anchor",
    "session_owner",
    "viewport_owner",
    "coalesced_count",
  ],
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
  "session.layout.composer_dock": [
    "dock_kind",
    "composer_height",
    "previous_composer_height",
    "scroll_top",
    "distance_from_bottom",
  ],
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
  if (/\b[a-z0-9.-]+\.[a-z]{2,}(?:\/|\?|:)/i.test(next)) return undefined
  if (/token=|key=|secret=|authorization/i.test(next)) return undefined
  return next.length > limit ? next.slice(0, limit) : next
}

function numberField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e15 ? value : undefined
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
    if (key === "endpoint_kind") {
      const value = stringField(input[key], 40)
      if (value === "prompt" || value === "continue" || value === "edit") output[key] = value
      continue
    }
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
    const value = JSON.parse(line) as Record<string, unknown>
    if (!value || typeof value !== "object") return undefined
    const time = stringField(value.time, 80)
    if (!time || !Number.isFinite(Date.parse(time))) return undefined
    const name = stringField(value["event.name"], 120)
    if (!name || !isAllowedEventName(name)) return undefined
    const appLaunchID = stringField(value.app_launch_id, 120)
    const windowID = stringField(value.window_id, 80)
    if (!appLaunchID || !windowID) return undefined
    const event: RendererDiagnosticEvent = {
      time,
      level: value.level === "warn" ? "warn" : "info",
      "event.name": name,
      app_launch_id: appLaunchID,
      window_id: windowID,
      data: sanitizeData(name, value.data),
    }
    const monotonic = numberField(value.monotonic_ms)
    if (monotonic !== undefined) event.monotonic_ms = monotonic
    const traceID = stringField(value.trace_id, 80)
    if (traceID) event.trace_id = traceID
    const routeID = stringField(value.route_session_id, 120)
    if (routeID) event.route_session_id = routeID
    const visibleID = stringField(value.visible_session_id, 120)
    if (visibleID) event.visible_session_id = visibleID
    const timelineID = stringField(value.timeline_session_id, 120)
    if (timelineID) event.timeline_session_id = timelineID
    const messageID = stringField(value.message_id, 120)
    if (messageID) event.message_id = messageID
    const partID = stringField(value.part_id, 120)
    if (partID) event.part_id = partID
    return event
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
  if (event["event.name"] !== "session.identity.transition") return false
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
  const selected = events.map((event) => ({
    event,
    bytes: jsonBytes(event),
  }))
  let totalBytes =
    selected.length === 0
      ? Buffer.byteLength("[]", "utf8")
      : 2 + selected.reduce((sum, item) => sum + item.bytes, 0) + selected.length - 1
  let omitted = 0
  while (selected.length > 0 && totalBytes > maxBytes) {
    const removable = selected.findIndex((item) => !isProtectedSliceContext(item.event))
    const index = removable >= 0 ? removable : 0
    const [removed] = selected.splice(index, 1)
    if (removed) totalBytes -= removed.bytes + (selected.length > 0 ? 1 : 0)
    omitted++
  }
  return {
    events: selected.map((item) => item.event),
    omittedEventCount: omitted,
    omittedBytes: Math.max(0, jsonBytes(events) - totalBytes),
  }
}

export function selectRendererDiagnosticsSlice(
  inputEvents: RendererDiagnosticEvent[],
  input: InternalSliceInput,
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
  now?: Date
}) {
  const maxBytes = input.maxBytes ?? GLOBAL_RENDERER_DIAGNOSTICS_EXPORT_MAX_BYTES
  let content = ""
  let status: RendererDiagnosticsStatus = "ok"
  try {
    content = await readFile(input.path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    status = "missing"
  }
  const lines = content.split(/\r?\n/).filter(Boolean)
  const events: RendererDiagnosticEvent[] = []
  let corruptLineCount = 0
  for (const line of lines) {
    const event = parseEventLine(line)
    if (event) events.push(event)
    else corruptLineCount++
  }
  const capped = capEvents(events, maxBytes)
  if (status === "ok" && capped.omittedEventCount > 0) status = "truncated"
  const output: RendererDiagnosticsExport = {
    schema_version: 1,
    format: "pawwork-renderer-diagnostics",
    source: "renderer-diagnostics",
    generated_at: (input.now ?? new Date()).toISOString(),
    diagnostics: {
      status,
      event_count: capped.events.length,
      incident_count: capped.events.filter(isIncident).length,
      corrupt_line_count: corruptLineCount,
      omitted_event_count: capped.omittedEventCount,
      omitted_bytes: capped.omittedBytes,
    },
    events: capped.events,
  }
  await writeFile(input.destination, `${JSON.stringify(output, null, 2)}\n`, "utf8")
}

export function createRendererDiagnosticsRecorder(options: RecorderOptions) {
  const maxBytes = options.maxBytes ?? DEFAULT_RENDERER_DIAGNOSTICS_MAX_BYTES
  const retentionMs = options.retentionMs ?? DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_MS
  const retentionCheckIntervalMs = options.retentionCheckIntervalMs ?? DEFAULT_RENDERER_DIAGNOSTICS_RETENTION_CHECK_MS
  const highFrequencyIntervalMs = options.highFrequencyIntervalMs ?? 250
  const now = options.now ?? (() => new Date())
  const path = rendererDiagnosticsPath(options.root)
  const lastHighFrequency = new Map<string, number>()
  let writeFailed = false
  let writeQueue = Promise.resolve()
  let lastRetentionCheck = 0

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

  const flushRetentionNow = async () => {
    const events = await readEvents()
    const cutoff = now().getTime() - retentionMs
    const retained = events.filter((event) => eventTime(event) >= cutoff)
    const lines = retained.map((event) => JSON.stringify(event))
    let totalBytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0)
    while (totalBytes > maxBytes && lines.length > 0) {
      const line = lines.shift()
      if (line) totalBytes -= Buffer.byteLength(line, "utf8") + 1
    }
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : ""
    await mkdir(options.root, { recursive: true })
    const temp = join(options.root, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temp, content, "utf8")
    await rename(temp, path).catch(async (error) => {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    })
  }

  const enqueueWrite = async <T>(operation: () => Promise<T>) => {
    const next = writeQueue.then(operation, operation)
    writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const drain = async () => {
    await writeQueue
  }

  const maybeFlushRetention = async () => {
    const current = now().getTime()
    const size = await stat(path).then(
      (stats) => stats.size,
      () => 0,
    )
    if (size <= maxBytes && current - lastRetentionCheck < retentionCheckIntervalMs) return
    lastRetentionCheck = current
    await flushRetentionNow()
  }

  const record = async (input: unknown, context: RecordContext) => {
    if (options.disabled) return { ok: false as const, reason: "disabled" as const }
    try {
      const sanitized = sanitizeRendererDiagnosticEvent(input, {
        appLaunchID: options.appLaunchID,
        now,
        windowID: context.windowID,
      })
      if (!sanitized) return { ok: false as const, reason: "dropped" as const }
      if (highFrequencyEvents.has(sanitized["event.name"])) {
        const key = `${sanitized.window_id}:${sanitized["event.name"]}`
        const current = now().getTime()
        const previous = lastHighFrequency.get(key)
        if (previous !== undefined && current - previous < highFrequencyIntervalMs) {
          return { ok: false as const, reason: "rate_limited" as const }
        }
        lastHighFrequency.set(key, current)
      }
      await enqueueWrite(async () => {
        await mkdir(options.root, { recursive: true })
        await appendFile(path, `${JSON.stringify(sanitized)}\n`, "utf8")
        await maybeFlushRetention()
      })
      writeFailed = false
      return { ok: true as const }
    } catch {
      writeFailed = true
      return { ok: false as const, reason: "write_failed" as const }
    }
  }

  const slice = async (input: SliceInput & { windowID?: string | number }) => {
    if (options.disabled) return emptyRendererDiagnosticsSlice("disabled", now())
    await drain()
    const report = await readEventReport()
    if (report.status === "missing") return emptyRendererDiagnosticsSlice(writeFailed ? "write_failed" : "missing", now())
    if (report.status === "corrupt" || (report.events.length === 0 && report.corruptLineCount > 0)) {
      return emptyRendererDiagnosticsSlice(writeFailed && report.status === "corrupt" ? "write_failed" : "corrupt", now())
    }
    writeFailed = false
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
    flushRetention: () => enqueueWrite(flushRetentionNow),
    drain,
    readEvents,
    readEventReport,
    slice,
  }
}
