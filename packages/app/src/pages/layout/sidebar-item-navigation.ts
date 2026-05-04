import type { Session } from "@opencode-ai/sdk/v2/client"

export type ShellLinkClick = {
  defaultPrevented: boolean
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type ShellOwnerLinkEvent = ShellLinkClick & {
  preventDefault: () => void
}

export function defaultSessionHref(slug: string, session: Pick<Session, "id">) {
  return `/${slug}/session/${session.id}`
}

export function defaultNewSessionHref(slug: string) {
  return `/${slug}/session`
}

export function shouldUseShellOwnerForLink(event: ShellLinkClick) {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  return true
}

export function openShellLinkWithOwner(event: ShellOwnerLinkEvent, open: () => void) {
  if (!shouldUseShellOwnerForLink(event)) return false
  event.preventDefault()
  open()
  return true
}
