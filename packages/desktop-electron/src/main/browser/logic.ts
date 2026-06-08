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

// --- Agent automation page scripts ---
// Built here as pure strings so they can be unit-tested without Electron, and so
// the only dynamic part — a CSS selector or target text — is always JSON-encoded
// and can never break out of the string literal into the surrounding script.

/**
 * Script for browser_extract: return the visible text of a CSS selector, or the
 * whole document body when no selector is given. Returns "" when the selector
 * matches nothing so the tool reports "no text" instead of failing.
 */
export function buildExtractScript(selector?: string): string {
  const sel = selector ? JSON.stringify(selector) : "null"
  return `(() => {
    const sel = ${sel};
    const root = sel ? document.querySelector(sel) : document.body;
    if (!root) return "";
    return root.innerText || root.textContent || "";
  })()`
}

/**
 * Predicate for browser_wait: true once a CSS selector matches, or once the body
 * text contains the target string. Selector wins when both are supplied.
 */
export function buildWaitScript(selector?: string, text?: string): string {
  const sel = selector ? JSON.stringify(selector) : "null"
  const txt = text ? JSON.stringify(text) : "null"
  return `(() => {
    const sel = ${sel};
    const txt = ${txt};
    if (sel) return !!document.querySelector(sel);
    if (txt) return ((document.body && document.body.innerText) || "").includes(txt);
    return false;
  })()`
}

/**
 * Script for browser_click: scroll the first match into view and return its
 * viewport rect (CSS px) so the controller can dispatch a real mouse event at its
 * center. Returns null when nothing matches.
 */
export function buildClickRectScript(selector: string): string {
  // behavior "instant" overrides a page's CSS `scroll-behavior: smooth`, so the
  // scroll completes synchronously and getBoundingClientRect reads the final
  // position — otherwise a smooth scroll would leave us clicking a stale rect.
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`
}

/**
 * Script for browser_type's targeting step: focus the first match and report
 * whether it became the active element. Returns false when nothing matches or the
 * element refused focus (e.g. disabled), so the tool can say so.
 */
export function buildFocusScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (typeof el.focus === "function") el.focus();
    return document.activeElement === el;
  })()`
}

export type ClickRect = { x: number; y: number; width: number; height: number }

/**
 * Center point (rounded, viewport CSS px) of an element rect for a synthetic mouse
 * click, or null when the rect is missing or has no area — a zero-size element is
 * not a real click target.
 */
export function clickPointFromRect(rect: ClickRect | null): { x: number; y: number } | null {
  if (!rect) return null
  if (rect.width <= 0 || rect.height <= 0) return null
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
}
