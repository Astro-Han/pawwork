export type LinkAction =
  | { kind: "external"; url: string }
  | { kind: "reveal"; path: string }
  | { kind: "anchor"; url: string }
  | { kind: "block" }

export function resolveLinkAction(href: string): LinkAction {
  const trimmed = href.trim()
  if (!trimmed) return { kind: "block" }
  if (trimmed.startsWith("#")) return { kind: "anchor", url: trimmed }
  // Protocol-relative URLs (//host/path) are remote-shaped; never reveal.
  if (trimmed.startsWith("//")) return { kind: "block" }
  // Block dangerous schemes outright; sanitize already strips most of these
  // at the href level, but defense in depth keeps the routing predictable.
  if (/^(?:javascript|data|vbscript):/i.test(trimmed)) return { kind: "block" }
  // Windows absolute paths (`C:\path` / `D:/path`) shape-match a generic
  // single-letter scheme followed by `:`. Catch them before the generic
  // scheme regex below so they reveal instead of routing to a browser.
  if (/^[a-z]:[\\/]/i.test(trimmed)) return { kind: "reveal", path: trimmed }
  // Any other scheme (https, mailto, vscode, tel, sms, git, ssh, ...) routes
  // to the external handler. Whether the scheme is actually surfaced to
  // users is governed by the DOMPurify ALLOWED_URI_REGEXP allowlist, not
  // here, which keeps schemes opt-in at sanitize time without forcing
  // every new addition to also touch the click router.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { kind: "external", url: trimmed }
  return { kind: "reveal", path: trimmed }
}

export type LinkActionHandlers = {
  openExternal?: (url: string) => void
  revealPath?: (path: string) => void
}

export function setupLinkClicks(root: HTMLDivElement, handlers: LinkActionHandlers) {
  const handler = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Element)) return
    const anchor = target.closest("a")
    if (!(anchor instanceof HTMLAnchorElement)) return
    if (anchor.closest('[data-slot="markdown-copy-button"]')) return
    const href = anchor.getAttribute("href") ?? ""
    const action = resolveLinkAction(href)
    event.preventDefault()
    if (action.kind === "block") return
    if (action.kind === "anchor") {
      const id = action.url.slice(1)
      if (!id) return
      const inner = root.querySelector(`#${CSS.escape(id)}`)
      if (inner instanceof HTMLElement) inner.scrollIntoView({ block: "start" })
      return
    }
    const desktop =
      typeof window !== "undefined"
        ? (window as unknown as {
            api?: {
              openLink?: (url: string) => void
              showItemInFolder?: (path: string) => unknown
            }
          }).api
        : undefined
    if (action.kind === "external") {
      if (handlers.openExternal) {
        handlers.openExternal(action.url)
      } else if (desktop?.openLink) {
        desktop.openLink(action.url)
      } else if (typeof window !== "undefined") {
        window.open(action.url, "_blank", "noopener,noreferrer")
      }
      return
    }
    if (action.kind === "reveal") {
      if (handlers.revealPath) {
        handlers.revealPath(action.path)
      } else if (desktop?.showItemInFolder) {
        void desktop.showItemInFolder(action.path)
      }
    }
  }
  // Capture phase so descendant stopPropagation cannot bypass routing.
  root.addEventListener("click", handler, true)
  return () => root.removeEventListener("click", handler, true)
}

export function setupImageClicks(root: HTMLDivElement, openImage: (src: string) => void) {
  const handler = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof HTMLImageElement)) return
    const src = target.getAttribute("src") ?? ""
    if (!src) return
    event.preventDefault()
    openImage(src)
  }
  root.addEventListener("click", handler)
  return () => root.removeEventListener("click", handler)
}
