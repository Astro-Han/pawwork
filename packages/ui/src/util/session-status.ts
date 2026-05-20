import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

/**
 * True when the session has work currently in flight: actively streaming (`busy`)
 * or actively retrying (`retry`).
 *
 * Notably FALSE for `rate_limit_blocked` — that state is terminal-visible: the
 * session has stopped, the RateLimitCard is shown, but no work is running, the
 * composer is not locked, and "Thinking" / "Stop" indicators should be off.
 *
 * Use this anywhere you would otherwise write `status.type !== "idle"`. The
 * legacy call sites are listed in the source spec §5.5.
 */
export function isWorkInFlightStatus(status: SessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry"
}
