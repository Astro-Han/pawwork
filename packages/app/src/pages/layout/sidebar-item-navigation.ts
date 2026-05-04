import type { Session } from "@opencode-ai/sdk/v2/client"

export type SidebarSessionClick = {
  defaultPrevented: boolean
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export function defaultSessionHref(slug: string, session: Pick<Session, "id">) {
  return `/${slug}/session/${session.id}`
}

export function shouldOpenSessionWithShell(event: SidebarSessionClick) {
  if (event.defaultPrevented) return false
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  return true
}
