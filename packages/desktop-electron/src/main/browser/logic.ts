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
 * Permission policy for the embedded browser, shared by the request handler and
 * the check handler (navigator.permissions.query) so the queried state and a
 * request outcome always agree. Grant exactly what a fresh Chrome grants without
 * a prompt; deny the rest — Electron's boolean handler can't express Chrome's
 * "prompt", and "denied" is the faithful substitute for the impossible "granted"
 * (Electron's default). Strings are Electron's permission names — camera and
 * microphone both arrive as "media". The set is measured against a fresh real
 * Chrome; the per-permission rationale (why midi is denied, payment-handler
 * granted) is in the PR description.
 */
const DEFAULT_GRANTED_PERMISSIONS = new Set([
  "clipboard-sanitized-write", // navigator.clipboard.writeText: granted by default
  "background-sync", // granted by default
  "sensors", // accelerometer / gyroscope / magnetometer: granted by default
  "payment-handler", // navigator.permissions.query("payment-handler"): granted by default in Chrome
  // Request-only (not exposed via permissions.query): Chrome allows these on a
  // user gesture WITHOUT a prompt, so denying them would break ordinary browsing
  // (e.g. fullscreen video) and be a tell. "fullscreen" is measurement-confirmed
  // to reach the request handler; "pointerLock" is Electron's documented request
  // permission name for the same allow-on-gesture API.
  "fullscreen",
  "pointerLock",
])

export function isDefaultGrantedPermission(permission: string): boolean {
  return DEFAULT_GRANTED_PERMISSIONS.has(permission)
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

export type DisplayDecision = "show" | "takeover" | "drop"

/**
 * Decide what a visible layout push from `win` may do with a conversation's
 * view — the heart of the claim/geometry split:
 *   - "show": the window already hosts the view, or nothing live does — apply
 *     bounds and show (no claim needed to attach from nothing).
 *   - "takeover": another window hosts it and this push claims the display —
 *     reparent, and tell the loser it lost.
 *   - "drop": another window hosts it and this push is a geometry-only tick —
 *     a resize frame in flight when the display changed hands must never
 *     steal the view back.
 */
export function displayDecision(input: { isHost: boolean; hasLiveHost: boolean; claim: boolean }): DisplayDecision {
  if (input.isHost || !input.hasLiveHost) return "show"
  return input.claim ? "takeover" : "drop"
}

export type ClearDataReloadAction = "now" | "defer" | "none"

/**
 * After a partition-wide data clear, decide how the embedded view should refresh
 * so it reflects the cleared (signed-out) cookies:
 *   - "now": a page is loaded → reload it immediately.
 *   - "defer": the first navigation is still in flight (no committed page yet, so
 *     hasPage is false) → it was sent with the pre-clear cookies, so reload once
 *     it settles instead of leaving stale signed-in content with no follow-up.
 *   - "none": nothing is loaded or loading → nothing to refresh.
 */
export function clearDataReloadAction(snapshot: { hasPage: boolean; loading: boolean }): ClearDataReloadAction {
  if (snapshot.hasPage) return "now"
  if (snapshot.loading) return "defer"
  return "none"
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
