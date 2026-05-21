import type { IncidentEvidenceSummary, RunIncident } from "./types"

const MAX_EXPORTED_EVIDENCE = 24
type LifecycleProvenance = NonNullable<RunIncident["provenance"]["lifecycle"]>

export function sanitizeIncident(incident: RunIncident): RunIncident {
  return {
    ...incident,
    provenance: sanitizeProvenance(incident.provenance),
    evidence: boundEvidence(incident),
  }
}

function sanitizeProvenance(provenance: RunIncident["provenance"]): RunIncident["provenance"] {
  return {
    ...provenance,
    lifecycle: provenance.lifecycle
      ? {
          ...provenance.lifecycle,
          origin: provenance.lifecycle.origin ? sanitizeOrigin(provenance.lifecycle.origin) : undefined,
          request: provenance.lifecycle.request ? sanitizeRequest(provenance.lifecycle.request) : undefined,
        }
      : undefined,
  }
}

function sanitizeOrigin(origin: NonNullable<LifecycleProvenance["origin"]>) {
  return {
    source: safeToken(origin?.source, "unknown"),
    operation: origin?.operation === undefined ? undefined : safeToken(origin.operation, "unknown"),
    reason: origin?.reason === undefined ? undefined : safeToken(origin.reason, "unknown"),
  }
}

function sanitizeRequest(request: NonNullable<LifecycleProvenance["request"]>) {
  return {
    method: safeMethod(request.method),
    path: safeRoutePath(request.path),
    source: safeToken(request.source, "unknown") as typeof request.source,
    directory_key: request.directory_key === undefined ? undefined : safeToken(request.directory_key, "unknown"),
    workspace_id: request.workspace_id === undefined ? undefined : safeToken(request.workspace_id, "unknown"),
    client_action: request.client_action
      ? {
          id: safeToken(request.client_action.id, "unknown"),
          kind: request.client_action.kind === undefined ? undefined : safeToken(request.client_action.kind, "unknown"),
          route_session_id:
            request.client_action.route_session_id === undefined
              ? undefined
              : safeToken(request.client_action.route_session_id, "unknown"),
          visible_session_id:
            request.client_action.visible_session_id === undefined
              ? undefined
              : safeToken(request.client_action.visible_session_id, "unknown"),
        }
      : undefined,
  }
}

function safeMethod(value: string) {
  const upper = value.toUpperCase()
  return /^(GET|POST|PATCH|PUT|DELETE|OPTIONS|HEAD)$/.test(upper) ? upper : "UNKNOWN"
}

function safeRoutePath(value: string) {
  const trimmed = value.trim().slice(0, 120)
  if (!trimmed.startsWith("/")) return "unknown"
  if (/\/Users\/|\/home\/|[/\\].*(token|secret|bearer|sk-|cookie|password)/i.test(trimmed)) return "unknown"
  if (!/^\/[a-zA-Z0-9_./:-]*$/.test(trimmed)) return "unknown"
  return trimmed
}

function safeToken(value: string | undefined, fallback: string) {
  if (!value) return fallback
  const trimmed = value.trim().slice(0, 100)
  if (!trimmed) return fallback
  if (/[/\\]|https?:\/\//i.test(trimmed)) return fallback
  if (/token|secret|bearer|sk-|cookie|password/i.test(trimmed)) return fallback
  if (!/^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return fallback
  return trimmed
}

function boundEvidence(incident: RunIncident): IncidentEvidenceSummary[] | undefined {
  const evidence = incident.evidence?.map(sanitizeEvidence)
  if (!evidence || evidence.length <= MAX_EXPORTED_EVIDENCE) return evidence

  const selected = new Set<number>()
  for (const event of evidence.slice(0, 8)) selected.add(event.order)
  for (const event of evidence.slice(-5)) selected.add(event.order)
  for (const event of evidence) {
    if (event.terminal_candidate || isCleanupEvidence(event.event_type)) {
      selected.add(event.order)
      selected.add(event.order - 1)
      selected.add(event.order + 1)
    }
  }

  const selectedEvents = capSelectedEvents(
    evidence.filter((event) => selected.has(event.order)).sort((left, right) => left.order - right.order),
  )
  const selectedOrders = new Set(selectedEvents.map((event) => event.order))
  const omitted = evidence.filter((event) => !selectedOrders.has(event.order))
  if (!omitted.length) return selectedEvents

  const firstOmitted = omitted[0]
  const marker: IncidentEvidenceSummary = {
    event_id: `${incident.incident_id}:evidence:omitted:${omitted.length}`,
    order: firstOmitted.order - 0.1,
    omitted_events: omitted.length,
    monotonic_ms: firstOmitted.monotonic_ms,
    source: "processor",
    event_type: "evidence_omitted",
    terminal_candidate: false,
    confidence: "medium",
  }

  return [...selectedEvents, marker].sort((left, right) => left.order - right.order)
}

function capSelectedEvents(events: IncidentEvidenceSummary[]) {
  const maxEventsBeforeMarker = MAX_EXPORTED_EVIDENCE - 1
  if (events.length <= maxEventsBeforeMarker) return events

  const anchorEvents = events.filter((event) => event.terminal_candidate || isCleanupEvidence(event.event_type))
  const nonAnchorEvents = events.filter((event) => !event.terminal_candidate && !isCleanupEvidence(event.event_type))
  const keptAnchors = anchorEvents.slice(-maxEventsBeforeMarker)
  const remaining = Math.max(0, maxEventsBeforeMarker - keptAnchors.length)
  const keptNonAnchors = remaining ? nonAnchorEvents.slice(-remaining) : []
  const kept = new Map<number, IncidentEvidenceSummary>()
  for (const event of [...keptNonAnchors, ...keptAnchors]) kept.set(event.order, event)
  return [...kept.values()].sort((left, right) => left.order - right.order)
}

function isCleanupEvidence(eventType: string) {
  return eventType === "pending_tool_part_interrupted" || eventType === "lifecycle_close_seen"
}

export function sanitizeEvidence(event: IncidentEvidenceSummary): IncidentEvidenceSummary {
  return {
    ...event,
    redactions: event.redactions?.map(safeRedactionMarker),
  }
}

function safeRedactionMarker(value: string) {
  const trimmed = value.trim().slice(0, 80)
  if (!trimmed) return "redacted"
  if (/[/\\]|https?:\/\//i.test(trimmed)) return "redacted"
  if (/token|secret|bearer|sk-|cookie|password/i.test(trimmed)) return "redacted"
  return trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "_") || "redacted"
}
