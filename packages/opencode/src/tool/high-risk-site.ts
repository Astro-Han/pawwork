/**
 * High-risk sites: platforms that run aggressive anti-automation risk control,
 * where automated browsing/viewing/posting can flag an account even when the
 * user is operating their own. We append a one-line caution to the browser
 * tool result so the model both adjusts (minimal, human-paced actions) and
 * relays the risk to the user — the embedded browser cannot fully match a real
 * Chrome profile's trust, so the residual risk is real and worth disclosing.
 *
 * Scope starts at Xiaohongshu (RedNote), the only platform we have actually
 * seen flag an account. Add an entry when a new platform shows the same
 * behavior; keep the list small and evidence-driven rather than guessing.
 */
type HighRiskSite = { name: string; hosts: string[] }

const HIGH_RISK_SITES: HighRiskSite[] = [{ name: "Xiaohongshu (RedNote)", hosts: ["xiaohongshu.com", "xhslink.com"] }]

/** Hostname of a full URL, or a bare host string (opencli's command.domain); null when empty. */
function hostnameOf(urlOrHost: string): string | null {
  const trimmed = urlOrHost.trim()
  if (!trimmed) return null
  // Parse everything through `new URL` so ports, queries, paths, and
  // protocol-relative ("//host/x") inputs all resolve to the bare hostname.
  // A protocol-less host gets a scheme prepended; leading slashes are dropped
  // first so "//host" doesn't become an empty authority.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : "http://" + trimmed.replace(/^\/+/, "")
  let host: string
  try {
    host = new URL(candidate).hostname.toLowerCase()
  } catch {
    return null
  }
  // A fully-qualified name can carry a root-label trailing dot
  // ("xiaohongshu.com." resolves to the same site, and `new URL` keeps it), so
  // strip leading/trailing dots before the suffix match — otherwise a trailing
  // dot slips past `endsWith(".xiaohongshu.com")`.
  return host.replace(/^\.+|\.+$/g, "") || null
}

function matchSite(urlOrHost: string): HighRiskSite | null {
  const host = hostnameOf(urlOrHost)
  if (!host) return null
  // Exact host or a subdomain of it. The leading dot stops `notxiaohongshu.com`
  // and `xiaohongshu.com.evil.com` from matching `xiaohongshu.com`.
  return HIGH_RISK_SITES.find((site) => site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null
}

/**
 * A caution to append to a browser tool result when it touches a high-risk
 * site, or null otherwise. Written for the model: it informs the agent and
 * tells it to relay the risk to the user.
 */
export function highRiskSiteNotice(urlOrHost: string): string | null {
  const site = matchSite(urlOrHost)
  if (!site) return null
  return (
    `Note: ${site.name} enforces strict anti-automation risk control. Automated browsing, viewing, or posting ` +
    `may trigger account risk warnings or restrictions, even when operating the user's own account. Tell the user ` +
    `about this risk, keep actions minimal and human-paced, and for anything sensitive (login or posting) suggest ` +
    `doing it manually in their own Chrome.`
  )
}

/**
 * High-risk caution for an OpenCLI command, checking BOTH its `domain` and a
 * string `navigateBefore` target — an adapter can navigate to a flagged site
 * that its `domain` field doesn't name. Null when neither is high-risk.
 */
export function highRiskCommandNotice(command: { domain?: string | null; navigateBefore?: unknown }): string | null {
  const targets = [command.domain, typeof command.navigateBefore === "string" ? command.navigateBefore : null]
  for (const target of targets) {
    if (target) {
      const notice = highRiskSiteNotice(target)
      if (notice) return notice
    }
  }
  return null
}
