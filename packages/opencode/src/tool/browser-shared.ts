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
      always: ["*"],
      metadata: { action: input.label, ...input.metadata },
    })
    return yield* Effect.tryPromise({
      try: () =>
        withBrowserPage(input.ctx.sessionID, input.label, input.run, {
          timeoutMs: input.timeoutMs,
          windowID: probe.windowID,
        }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    })
  })
}

/** One-line note appended to the first action after the agent takes over an already-open page. */
export function takeoverNote(info: { takeoverReloaded: boolean }): string {
  return info.takeoverReloaded ? "\n\nNote: attached to the page that was already open; it was reloaded once to apply automation hardening." : ""
}
