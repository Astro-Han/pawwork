import {
  deriveIncident as deriveRunIncident,
  providerApiCause as deriveProviderApiCause,
  transportCause as providerTransportCause,
} from "./derive"
import { recoveryFor as deriveRecovery } from "./policy"
import { plainSummary as derivePlainSummary, userSummary as deriveUserSummary } from "./presentation"
import { sanitizeIncident as sanitizeRunIncident, sanitizeLifecycleRequest } from "./sanitize"
import { evaluateReplaySafety as deriveReplaySafety } from "./safety-gate"
import { RUN_INCIDENT_SCHEMA_VERSION as VERSION } from "./types"
import * as Types from "./types"

function exportChain(incident: Types.RunIncident): Types.ExportIncidentChain {
  return {
    incident_id: incident.incident_id,
    run_id: incident.run_id,
    session_id: incident.session_id,
    message_id: incident.message_id,
    terminal_cause_category: incident.terminal_cause.category,
    terminal_cause_subcategory:
      "subcategory" in incident.terminal_cause ? String(incident.terminal_cause.subcategory) : undefined,
    run_phase: incident.phase.run_phase,
    stream_phase: incident.phase.stream_phase,
    tool_phase: incident.phase.tool_phase,
    recovery_recommendation: incident.recovery.recommendation,
    nearest_origin: incident.provenance.lifecycle?.origin,
    nearest_request: incident.provenance.lifecycle?.request,
    missing_provenance: incident.missing_provenance,
    diagnostics_complete: incident.diagnostics_complete,
    plain_summary: incident.plain_summary,
  }
}

export namespace RunIncident {
  export const SCHEMA_VERSION = VERSION
  export const derive = deriveRunIncident
  export const transportCause = providerTransportCause
  export const providerApiCause = deriveProviderApiCause
  export const recoveryFor = deriveRecovery
  export const evaluateReplaySafety = deriveReplaySafety
  export const userSummary = deriveUserSummary
  export const plainSummary = derivePlainSummary
  export const sanitize = sanitizeRunIncident
  export const sanitizeRequest = sanitizeLifecycleRequest
  export const toExportChain = exportChain

  export type Summary = Types.RunIncident
  export type RunIncident = Types.RunIncident
  export type EvidenceEvent = Types.IncidentEvidenceEvent
  export type EvidenceSummary = Types.IncidentEvidenceSummary
  export type TerminalCause = Types.TerminalCause
  export type Phase = Types.IncidentPhase
  export type Facts = Types.IncidentFacts
  export type Recovery = Types.RecoveryDecision
  export type MaterializedToolBoundary = Types.MaterializedToolBoundary
  export type ExportIncidentChain = Types.ExportIncidentChain
}
