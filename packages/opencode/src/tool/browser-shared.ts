import { Effect } from "effect"
import type { IPage } from "@jackwener/opencli/types"
import * as Tool from "./tool"
import { browserPageProbe, withBrowserPage } from "@/browser/session"
import { highRiskSiteNotice } from "./high-risk-site"

/** Info handed to every browser action's `run` callback and used to build the trailing notes on its output. */
export type BrowserActionInfo = { takeoverReloaded: boolean; highRiskNotice: string | null }

/**
 * Shared execution path for the browser_* tools: ask the `browser` permission
 * (default allow via the agent's `"*": "allow"` baseline; a configured
 * `permission.browser` rule can tighten it per target), then run the action
 * through BrowserSession with its tool-level timeout. Browser failures arrive
 * as readable Errors (typed bridge errors, opencli TargetError messages) and
 * pass through unchanged.
 */
export function runBrowserAction<T>(input: {
  ctx: Tool.Context
  label: string
  /**
   * Permission targets. navigate passes its destination so the URL can be gated
   * before we go there; every other action omits this and is scoped to the
   * page's current URL, so a URL-specific allow/deny rule decides per site
   * (without it a current-page action would always match the `*` rule).
   */
  patterns?: string[]
  metadata?: Record<string, unknown>
  timeoutMs?: number
  run: (page: IPage, info: BrowserActionInfo) => Promise<T>
}) {
  return Effect.gen(function* () {
    // EVERY action starts by reading the session's own page URL. The
    // permission is judged against it (unless the caller passed explicit
    // patterns like navigate's destination), and the action can only ever
    // land in that same session's view. A probe failure fails right here,
    // before the ask.
    const probe = yield* Effect.tryPromise({
      try: () => browserPageProbe(input.ctx.sessionID),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    })
    const patterns = input.patterns ?? [probe.url ?? "*"]
    yield* input.ctx.ask({
      permission: "browser",
      patterns,
      always: browserAlwaysPatterns(patterns),
      metadata: { action: input.label, ...input.metadata },
    })
    // The ask can sit open for minutes, and the user can keep browsing the
    // view meanwhile — a current-page approval judged against one URL must not
    // be spent on whatever page the view reached by the time it was granted.
    // Re-probe and, when the URL changed at all, ask AGAIN against the page as
    // it is now — the same re-judge navigate applies to a redirect landing, and
    // the full-URL granularity matters: a configured rule can be path-scoped
    // (deny https://site/admin/*), which an origin compare would slip past.
    // An unchanged URL — the common case — skips this entirely. Explicit-
    // pattern actions (navigate) were judged against their destination, which
    // no amount of meanwhile-browsing changes.
    // The URL the action actually operates on: navigate's destination, or the
    // page the session is on (updated if it moved while the ask was open).
    let actedUrl = input.patterns?.[0] ?? probe.url
    if (!input.patterns) {
      const recheck = yield* Effect.tryPromise({
        try: () => browserPageProbe(input.ctx.sessionID),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      })
      if (recheck.url !== probe.url) {
        actedUrl = recheck.url
        const moved = [recheck.url ?? "*"]
        yield* input.ctx.ask({
          permission: "browser",
          patterns: moved,
          always: browserAlwaysPatterns(moved),
          metadata: { action: input.label, movedFrom: probe.url ?? undefined, ...input.metadata },
        })
      }
    }
    // Compute the high-risk caution once, here, so EVERY browser action (not
    // just navigate) surfaces it when it touches a flagged site — the tools
    // surface it via withNotes(info), which leads the output so head-first
    // truncation can't drop it.
    const highRiskNotice = actedUrl ? highRiskSiteNotice(actedUrl) : null
    return yield* Effect.tryPromise({
      try: () =>
        withBrowserPage(
          input.ctx.sessionID,
          input.label,
          (page, info) => input.run(page, { ...info, highRiskNotice }),
          {
            timeoutMs: input.timeoutMs,
            // User stop must reach the page driver: on abort the session severs
            // the CDP connection so the in-flight action cannot keep operating
            // the page after the user canceled it.
            abort: input.ctx.abort,
          },
        ),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    })
  })
}

/**
 * Origin-scoped "always allow" patterns for a browser ask. Approvals are
 * evaluated AFTER configured rules (last match wins), so a global "*" grant
 * would let one click on a harmless site silently override an explicit
 * per-URL deny the user configured; an origin pattern can never out-match
 * another site's rule. Non-URL targets (blank page) contribute none.
 */
export function browserAlwaysPatterns(patterns: string[]): string[] {
  return patterns.flatMap((pattern) => {
    try {
      return [`${new URL(pattern).origin}/*`]
    } catch {
      return []
    }
  })
}

/** One-line note appended to the first action after the agent takes over an already-open page. */
export function takeoverNote(info: { takeoverReloaded: boolean }): string {
  return info.takeoverReloaded ? "\n\nNote: attached to the page that was already open; it was reloaded once to apply automation hardening." : ""
}

/**
 * Compose a browser tool's output with its notes, safety-first. Tool results are
 * truncated head-first (the tail is dropped and replaced by a "...truncated..."
 * hint), so the high-risk caution must LEAD the output — appended after a large
 * body (a full snapshot, extracted page text) it would be silently cut on
 * exactly the high-risk pages that matter. The informational takeover note (fine
 * to lose) stays trailing. Both are computed centrally in runBrowserAction and
 * carried on `info`, so every browser tool gets identical coverage from this one
 * call.
 */
export function withNotes(info: BrowserActionInfo, body: string): string {
  const lead = info.highRiskNotice ? `${info.highRiskNotice}\n\n` : ""
  return lead + body + takeoverNote(info)
}

/**
 * opencli's target resolver treats ONLY a bare number as a snapshot ref —
 * "[12]" falls through to querySelectorAll and fails as an invalid CSS
 * selector. But browser_snapshot prints refs as "[12]" and the tool
 * descriptions teach that spelling, so models echo it. Accept the bracketed
 * form here and hand opencli the number; anything else passes through as a
 * CSS selector.
 */
export function normalizeElementRef(ref: string): string {
  const match = /^\s*\[(\d+)\]\s*$/.exec(ref)
  return match ? match[1] : ref
}
