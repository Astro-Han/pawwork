/**
 * Address-bar input → navigable URL string.
 *
 * The embedded browser is a content viewer, not a search box: v1 only resolves
 * URLs (no search-engine fallback, which would be a product decision about which
 * engine). Anything already carrying a `scheme://` is passed through untouched —
 * the main process validates the scheme before loading, so this stays purely
 * about shaping the string. Bareword/host input gets a scheme: `http://` for
 * loopback hosts (so a local dev server like "localhost:3000" just works) and
 * `https://` for everything else. Returns null for empty input (no navigation).
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * Loopback hosts only ever route to the local machine, so plaintext http has no
 * MITM surface — and local dev servers are overwhelmingly http. Private LAN
 * addresses are intentionally excluded: their network may be hostile, so they
 * keep the https default and the user opts into plaintext by typing http://.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    LOOPBACK_IPV4.test(h)
  )
}

export function normalizeAddressInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Anything with a `scheme://` is passed through for the main process to validate.
  if (HAS_SCHEME.test(trimmed)) return trimmed
  // Bareword host[:port][/path]. Parse with a throwaway scheme to read the bare
  // hostname (drops the port/path, normalizes IPv6) and pick the scheme from it.
  let host = trimmed
  try {
    host = new URL(`http://${trimmed}`).hostname
  } catch {
    // Unparseable as a host — fall through with the raw string and the https default.
  }
  return `${isLoopbackHost(host) ? "http" : "https"}://${trimmed}`
}

/**
 * Split a loaded URL into host + remainder for the address bar's two-tone
 * display (host emphasized, path muted). Falls back to the raw string when it
 * does not parse as a URL. `www.` is stripped and a lone `/` path is dropped to
 * keep the common case clean.
 */
export function formatAddress(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./, "")
    const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
    return { host, path: rest === "/" ? "" : rest }
  } catch {
    return { host: url, path: "" }
  }
}
