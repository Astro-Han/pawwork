import type { BrowserViewRect } from "@/context/platform"

/**
 * Whether the native WebContentsView overlay should be shown over the panel's
 * content region. It is a native layer painted on top of the DOM, so it must be
 * hidden whenever something should sit above it:
 *   - panel collapsed or this tab not active → nothing to overlay,
 *   - no page loaded yet → the DOM empty state shows instead,
 *   - suppressed: an app modal / the browser's own menu is open → it would paint
 *     over them.
 * Navigating away (settings / automations / skills are real routes) unmounts
 * this panel entirely; its onCleanup hides the view, so no covered flag needed.
 */
export function shouldShowBrowserView(input: {
  panelOpen: boolean
  active: boolean
  hasPage: boolean
  suppressed: boolean
}): boolean {
  return input.panelOpen && input.active && input.hasPage && !input.suppressed
}

/**
 * Compare two viewport rects at device-pixel resolution. The renderer measures
 * the host every animation frame while visible; this gate keeps sub-pixel jitter
 * from spamming the bounds IPC, since the main process rounds to integers anyway.
 */
export function rectsEqual(a: BrowserViewRect | null, b: BrowserViewRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  )
}
