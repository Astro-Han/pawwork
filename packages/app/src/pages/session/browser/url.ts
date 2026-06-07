/**
 * Address-bar input → navigable URL string.
 *
 * The embedded browser is a content viewer, not a search box: v1 only resolves
 * URLs (no search-engine fallback, which would be a product decision about which
 * engine). Anything already carrying a `scheme://` is passed through untouched —
 * the main process validates the scheme before loading, so this stays purely
 * about shaping the string. Bareword/host input gets `https://` so the common
 * case ("example.com") just works. Returns null for empty input (no navigation).
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

export function normalizeAddressInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // `host:port` (e.g. localhost:3000) has no `//`, so it is NOT treated as a
  // scheme and correctly gets the https prefix below.
  if (HAS_SCHEME.test(trimmed)) return trimmed
  return `https://${trimmed}`
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
