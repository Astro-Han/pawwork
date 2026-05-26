import type { SideEffectBoundarySnapshot } from "./types"
import { toolEffect } from "./sanitize"
import { isRecord } from "@/util/record"

export function sideEffectBoundarySnapshot(tools: Record<string, unknown> | undefined): SideEffectBoundarySnapshot {
  const entries = Object.entries(tools ?? {})
  const names = entries.map(([name]) => name)
  const effects = names.map((name) => toolEffect(name))
  const unknownCount = effects.filter((effect) => effect.kind === "unknown").length
  const unclassifiedCount = effects.filter((effect) => !effect.complete).length
  const providerExecutedCapabilityPresent = entries.some(([, item]) => isRecord(item) && item.type === "provider")
  const externalBoundaryPresent = entries.some(
    ([, item]) => isRecord(item) && (item as { externalResult?: unknown }).externalResult === true,
  )
  const unknownBoundaryPresent = entries.some(([, item]) => !isRecord(item))
  const incomplete = unknownCount > 0 || unclassifiedCount > 0
  const proofReason = providerExecutedCapabilityPresent
    ? "provider_executed_capability"
    : externalBoundaryPresent
      ? "external_boundary"
      : unknownBoundaryPresent
        ? "unknown"
        : incomplete
          ? unknownCount > 0
            ? "unknown_tool_boundary"
            : "unclassified_effect"
          : "all_boundaries_classified"
  return {
    exposed_tool_count: names.length,
    unknown_tool_count: unknownCount,
    unclassified_effect_count: unclassifiedCount,
    provider_executed_capability_present: providerExecutedCapabilityPresent,
    external_boundary_present: externalBoundaryPresent,
    proof_result:
      incomplete || providerExecutedCapabilityPresent || externalBoundaryPresent || unknownBoundaryPresent
        ? "incomplete"
        : "complete",
    proof_reason: proofReason,
  }
}

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
