export type ContextUsageTone = "normal" | "warning" | "danger"

export function contextUsageTone(usage: number | null | undefined): ContextUsageTone {
  if (usage === undefined || usage === null) return "normal"
  if (usage >= 90) return "danger"
  if (usage >= 70) return "warning"
  return "normal"
}

export function contextUsageRingPercent(usage: number | null | undefined) {
  return Math.max(0, Math.min(100, usage ?? 0))
}

// Where the auto-compaction tick sits on the budget meter, as a percent of the input limit. Returns
// undefined when there is no threshold to draw. compactThreshold is a legitimate 0 when reserved >=
// the input limit (deriveContextUsage clamps with Math.max(0, ...)), so test for missing explicitly
// rather than with a falsy check, which would drop the 0% tick.
export function contextBudgetMarkerPercent(input: {
  autoCompactEnabled: boolean
  compactThreshold: number | undefined
  effectiveInputLimit: number | undefined
}): number | undefined {
  if (!input.autoCompactEnabled) return undefined
  if (input.compactThreshold === undefined) return undefined
  if (input.effectiveInputLimit === undefined || input.effectiveInputLimit <= 0) return undefined
  return (input.compactThreshold / input.effectiveInputLimit) * 100
}
