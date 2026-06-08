import type { BrowserViewRect } from "@/context/platform"

/**
 * Whether the native WebContentsView overlay should be shown over the panel's
 * content region. It is a native layer painted on top of the DOM, so it must be
 * hidden whenever something should sit above it:
 *   - panel collapsed or this tab not active → nothing to overlay,
 *   - no page loaded yet → the DOM empty state shows instead,
 *   - suppressed: an app modal / the browser's own menu is open → it would paint
 *     over them,
 *   - coveredBySurface: a full-region takeover (settings / automations / skills)
 *     covers the session. The session DOM stays mounted (CSS-hidden, not
 *     unmounted, to preserve its state), but a native layer ignores CSS, so it
 *     must be hidden explicitly or it bleeds through the takeover.
 */
export function shouldShowBrowserView(input: {
  panelOpen: boolean
  active: boolean
  hasPage: boolean
  suppressed: boolean
  coveredBySurface: boolean
}): boolean {
  return input.panelOpen && input.active && input.hasPage && !input.suppressed && !input.coveredBySurface
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
