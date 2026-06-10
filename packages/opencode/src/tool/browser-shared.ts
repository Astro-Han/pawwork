import { Effect } from "effect"
import type { IPage } from "@jackwener/opencli/types"
import * as Tool from "./tool"
import { browserPageProbe, withBrowserPage } from "@/browser/session"

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
  run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>
}) {
  return Effect.gen(function* () {
    // EVERY action starts with one window pick — the lease. The permission is
    // judged against it (current-page URL, unless the caller passed explicit
    // patterns like navigate's destination) and the attach is pinned to it,
    // so a focus change between the ask and the action can never retarget
    // either. No serveable window fails right here, before the ask — an
    // un-leased action could otherwise ride a `*` grant onto whatever window
    // focus lands on.
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
    return yield* Effect.tryPromise({
      try: () =>
        withBrowserPage(input.ctx.sessionID, input.label, input.run, {
          timeoutMs: input.timeoutMs,
          windowID: probe.windowID,
          // User stop must reach the page driver: on abort the session severs
          // the CDP connection so the in-flight action cannot keep operating
          // the page after the user canceled it.
          abort: input.ctx.abort,
        }),
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
