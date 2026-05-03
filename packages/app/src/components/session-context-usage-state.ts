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
