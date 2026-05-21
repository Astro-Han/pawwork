import { deriveIncident as deriveRunIncident, transportCause as providerTransportCause } from "./derive"
import { recoveryFor as deriveRecovery } from "./policy"
import { plainSummary as derivePlainSummary, userSummary as deriveUserSummary } from "./presentation"
import { sanitizeIncident as sanitizeRunIncident } from "./sanitize"
import { RUN_INCIDENT_SCHEMA_VERSION as VERSION } from "./types"
import * as Types from "./types"

export namespace RunIncident {
  export const SCHEMA_VERSION = VERSION
  export const derive = deriveRunIncident
  export const transportCause = providerTransportCause
  export const recoveryFor = deriveRecovery
  export const userSummary = deriveUserSummary
  export const plainSummary = derivePlainSummary
  export const sanitize = sanitizeRunIncident

  export type Summary = Types.RunIncident
  export type RunIncident = Types.RunIncident
  export type EvidenceEvent = Types.IncidentEvidenceEvent
  export type EvidenceSummary = Types.IncidentEvidenceSummary
  export type TerminalCause = Types.TerminalCause
  export type Phase = Types.IncidentPhase
  export type Facts = Types.IncidentFacts
  export type Recovery = Types.RecoveryDecision
}
