export type DshNavigationDecision = "same-window" | "external" | "deny"

export function decideDshNavigation(dshUrl: string, target: string): DshNavigationDecision {
  try {
    const dsh = new URL(dshUrl)
    const destination = new URL(target)
    if (destination.origin === dsh.origin) return "same-window"
    if (destination.protocol === "http:" || destination.protocol === "https:") return "external"
    return "deny"
  } catch {
    return "deny"
  }
}
