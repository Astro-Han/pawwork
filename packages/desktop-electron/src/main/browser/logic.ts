import type { BrowserState } from "@opencode-ai/app/desktop-api"

/**
 * Validate an address before loading it into the embedded view. Only http/https
 * are navigable: file://, javascript:, and other schemes are rejected so a typed
 * address or an in-page link can never reach the local filesystem or privileged
 * surfaces. Returns the parsed (normalized) URL string, or null if not allowed.
 */
export function parseNavigable(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
  return null
}

// Page-provided non-web links are handed to the OS only for this tight set of
// schemes. Everything else (file:, javascript:, custom app protocols) is dropped
// so a hostile page can't launch local files or arbitrary registered handlers.
const EXTERNAL_SCHEMES = new Set(["mailto:", "tel:"])

/**
 * The page-provided URL to hand to the system handler, or null to drop it. Only
 * a small allow-list of safe schemes escapes; navigable http/https links are
 * handled in-place by parseNavigable and never reach here.
 */
export function safeExternalUrl(url: string): string | null {
  const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase()
  return EXTERNAL_SCHEMES.has(scheme) ? url : null
}

/**
 * Convert a CSS-pixel viewport rect (reported by the renderer) into the
 * device-independent pixel bounds a WebContentsView expects. The renderer is
 * zoom-agnostic; the window's zoom factor is applied here as the single source
 * of truth. Negative sizes are clamped to 0 (setBounds rejects negatives).
 */
export function computeViewBounds(
  rect: { x: number; y: number; width: number; height: number },
  zoomFactor: number,
): { x: number; y: number; width: number; height: number } {
  const z = zoomFactor > 0 ? zoomFactor : 1
  return {
    x: Math.round(rect.x * z),
    y: Math.round(rect.y * z),
    width: Math.max(0, Math.round(rect.width * z)),
    height: Math.max(0, Math.round(rect.height * z)),
  }
}

export type BrowserStateSnapshot = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  favicon: string | null
}

/**
 * Derive the renderer-facing state from a raw webContents snapshot. `hasPage` is
 * false until a real page is loaded (empty or about: URL), which keeps the DOM
 * empty state visible and the native overlay hidden; `secure` reflects https.
 */
export function deriveBrowserState(snapshot: BrowserStateSnapshot): BrowserState {
  return {
    url: snapshot.url,
    title: snapshot.title,
    canGoBack: snapshot.canGoBack,
    canGoForward: snapshot.canGoForward,
    loading: snapshot.loading,
    favicon: snapshot.favicon,
    secure: /^https:\/\//i.test(snapshot.url),
    hasPage: snapshot.url !== "" && !snapshot.url.startsWith("about:"),
  }
}
