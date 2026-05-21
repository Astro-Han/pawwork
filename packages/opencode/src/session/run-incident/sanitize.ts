import type { IncidentEvidenceSummary, RunIncident } from "./types"

const MAX_EXPORTED_EVIDENCE = 24

export function sanitizeIncident(incident: RunIncident): RunIncident {
  return {
    ...incident,
    evidence: boundEvidence(incident),
  }
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

  const selectedEvents = evidence
    .filter((event) => selected.has(event.order))
    .sort((left, right) => left.order - right.order)
    .slice(0, MAX_EXPORTED_EVIDENCE - 1)
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
