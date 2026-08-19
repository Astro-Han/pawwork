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

type NavigationEvent = { preventDefault: () => void }
type OpenExternal = (target: string) => Promise<unknown>

export function guardDshNavigation(
  dshUrl: string,
  target: string,
  event: NavigationEvent,
  openExternal: OpenExternal,
) {
  const decision = decideDshNavigation(dshUrl, target)
  if (decision === "same-window") return

  event.preventDefault()
  if (decision === "external") void openExternal(target)
}
