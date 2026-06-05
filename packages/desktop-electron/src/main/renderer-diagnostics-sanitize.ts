import {
  RENDERER_DIAGNOSTIC_EVENT_MAX_BYTES,
  type RendererDiagnosticEvent,
  type RendererDiagnosticInput,
  type SanitizeContext,
} from "./renderer-diagnostics-types"

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
  "session.action.abort": ["source", "mode", "result"],
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
    "anchor_changed",
    "reason",
    "anchor_kind",
    "anchor_message_id",
    "near_top",
    "near_bottom",
    "session_owner",
    "viewport_owner",
  ],
  "session.timeline.reconcile": [
    "reason",
    "outcome",
    "anchor_kind",
    "anchor_message_id",
    "reveal_attempts",
    "delta",
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

export const highFrequencyDiagnosticEvents = new Set([
  "session.timeline.scroll_controller",
  "session.timeline.reconcile",
  "session.scroll.sample",
  "renderer.perf.sample",
])

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

export function safeJsonBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function jsonBytes(value: unknown) {
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

export function parseEventLine(line: string): RendererDiagnosticEvent | undefined {
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
