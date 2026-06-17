/**
 * The embedded browser's user-agent. The view is real Chromium, so the faithful
 * identity is a plain Chrome UA: strip Electron's `Electron/` and app product
 * tokens (a real Chrome UA has nothing where Electron injects them) and pin the
 * Chrome token to the `<major>.0.0.0` form, deriving the major from the running
 * engine (`process.versions.chrome`). Pure (no electron import) so it stays
 * unit-tested; the partition wiring is configurePartitionUserAgent, called from
 * controller.ts. Full rationale in the PR description.
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

/** Minimal Session surface the partition wiring needs — narrowed so the rewrite is testable without an Electron runtime. */
export interface UserAgentSession {
  getUserAgent(): string
  setUserAgent(userAgent: string): void
}

/**
 * Apply the faithful Chrome UA to the embedded browser's partition session. The
 * seam controller.ts calls (on the real partition session) before the first view
 * is created, so the cleaned UA is in place before any embedded load.
 */
export function configurePartitionUserAgent(sess: UserAgentSession, chromeVersion: string): void {
  sess.setUserAgent(toChromeUserAgent(sess.getUserAgent(), chromeVersion))
}
