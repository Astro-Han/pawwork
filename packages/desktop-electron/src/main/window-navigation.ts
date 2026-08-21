export type DshNavigationDecision = "same-window" | "external" | "deny"

// The URL is optional because the window now outlives the runtime: it opens on
// the local startup page before DSH has an origin, and goes back to that page
// when DSH dies. With no origin to belong to, nothing belongs to it.
export function decideDshNavigation(dshUrl: string | undefined, target: string): DshNavigationDecision {
  if (dshUrl === undefined) return "deny"
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
type LoadUrl = (target: string) => unknown

export function guardDshNavigation(
  dshUrl: string | undefined,
  target: string,
  event: NavigationEvent,
  openExternal: OpenExternal,
) {
  const decision = decideDshNavigation(dshUrl, target)
  if (decision === "same-window") return

  event.preventDefault()
  if (decision === "external") void openExternal(target)
}

// DSH asks for a popup window; PawWork has one window, so the popup is always
// denied and the destination is re-homed by the same decision the main frame
// uses. Kept here rather than inline in the window so the deny branch — a
// privileged scheme must reach neither the window nor the browser — is testable
// without an Electron window.
export function handleDshWindowOpen(
  dshUrl: string | undefined,
  target: string,
  loadInSameWindow: LoadUrl,
  openExternal: OpenExternal,
) {
  const decision = decideDshNavigation(dshUrl, target)
  if (decision === "same-window") void loadInSameWindow(target)
  if (decision === "external") void openExternal(target)
  return { action: "deny" as const }
}
