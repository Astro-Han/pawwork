/**
 * The embedded browser's user-agent string. The view is real Chromium (Electron),
 * so the honest, low-false-positive identity is a faithful Chrome UA. Electron's
 * default string carries an `Electron/<ver>` token plus the app's own product
 * token (`opencode/<ver>` after index.ts's rewrite, or `PawWork .../<ver>` before
 * it) right where a real Chrome UA has nothing — both are obvious "not a normal
 * browser" tells that anti-automation risk control keys on. We strip them and pin
 * the Chrome token to the reduced `<major>.0.0.0` form modern Chrome reports,
 * deriving the major from the real embedded Chromium (`process.versions.chrome`)
 * so it can never drift from the engine actually running.
 *
 * Pure (no electron import) so it is unit-pinned; the wiring onto the browser
 * partition lives in controller.ts.
 */

/** Major version of a Chromium version string, or null if it has no leading number. */
export function chromeMajorVersion(chromeVersion: string): string | null {
  const major = chromeVersion.trim().split(".")[0]
  return /^\d+$/.test(major) ? major : null
}

/**
 * Rewrite an Electron user-agent into the faithful Chrome UA the embedded view
 * should present. Idempotent: an already-clean Chrome UA passes through unchanged.
 */
export function toChromeUserAgent(rawUserAgent: string, chromeVersion: string): string {
  const major = chromeMajorVersion(chromeVersion)
  let ua = rawUserAgent
    // Drop the Electron product token — the loudest non-Chrome tell.
    .replace(/ Electron\/\S+/g, "")
    // Drop the app/product token Electron injects between the engine comment and
    // the Chrome token (a real Chrome UA has nothing there).
    .replace(/(\(KHTML, like Gecko\) ).*?(Chrome\/)/, "$1$2")
  // Pin the Chrome token to the reduced major.0.0.0 form real Chrome reports.
  if (major) ua = ua.replace(/Chrome\/\S+/, `Chrome/${major}.0.0.0`)
  return ua.replace(/ {2,}/g, " ").trim()
}
