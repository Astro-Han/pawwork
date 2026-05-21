import type { IncidentEvidenceSummary, RunIncident } from "./types"

const MAX_EXPORTED_EVIDENCE = 24

export function sanitizeIncident(incident: RunIncident): RunIncident {
  return {
    ...incident,
    evidence: incident.evidence?.slice(0, MAX_EXPORTED_EVIDENCE).map(sanitizeEvidence),
  }
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
