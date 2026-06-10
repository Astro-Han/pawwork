import { Effect } from "effect"
import type { IPage } from "@jackwener/opencli/types"
import * as Tool from "./tool"
import { withBrowserPage } from "@/browser/session"

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
  /** Permission targets; navigate passes the URL so rules can scope by site. */
  patterns?: string[]
  metadata?: Record<string, unknown>
  timeoutMs?: number
  run: (page: IPage, info: { takeoverReloaded: boolean }) => Promise<T>
}) {
  return Effect.gen(function* () {
    yield* input.ctx.ask({
      permission: "browser",
      patterns: input.patterns ?? ["*"],
      always: ["*"],
      metadata: { action: input.label, ...input.metadata },
    })
    return yield* Effect.tryPromise({
      try: () => withBrowserPage(input.ctx.sessionID, input.label, input.run, { timeoutMs: input.timeoutMs }),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    })
  })
}

/** One-line note appended to the first action after the agent takes over an already-open page. */
export function takeoverNote(info: { takeoverReloaded: boolean }): string {
  return info.takeoverReloaded ? "\n\nNote: attached to the page that was already open; it was reloaded once to apply automation hardening." : ""
}
