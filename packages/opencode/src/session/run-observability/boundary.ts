import type { SideEffectBoundarySnapshot } from "./types"

export function allowsBeforeProgressRetry(snapshot: SideEffectBoundarySnapshot | undefined) {
  if (!snapshot) return false
  if (snapshot.provider_executed_capability_present !== false) return false
  if (snapshot.external_boundary_present !== false) return false
  if (
    snapshot.proof_reason === "provider_executed_capability" ||
    snapshot.proof_reason === "external_boundary" ||
    snapshot.proof_reason === "unknown"
  ) {
    return false
  }
  return true
}
