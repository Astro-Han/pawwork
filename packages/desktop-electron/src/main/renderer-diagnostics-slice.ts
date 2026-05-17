import type {
  InternalSliceInput,
  RendererDiagnosticEvent,
  RendererDiagnosticsSlice,
  RendererDiagnosticsStatus,
} from "./renderer-diagnostics-types"
import { jsonBytes } from "./renderer-diagnostics-sanitize"

export function eventTime(event: RendererDiagnosticEvent) {
  const time = Date.parse(event.time)
  return Number.isFinite(time) ? time : 0
}

export function eventMatchesSession(event: RendererDiagnosticEvent, sessionID: string) {
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

export function isIncident(event: RendererDiagnosticEvent) {
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

export function capEvents(events: RendererDiagnosticEvent[], maxBytes: number) {
  const selected = events.map((event) => ({
    event,
    bytes: jsonBytes(event),
  }))
  let totalBytes =
    selected.length === 0 ? Buffer.byteLength("[]", "utf8") : 2 + selected.reduce((sum, item) => sum + item.bytes, 0) + selected.length - 1
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
