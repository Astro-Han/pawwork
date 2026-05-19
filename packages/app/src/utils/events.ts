/**
 * First-slice telemetry hook for #741. This implementation deliberately writes
 * to console only — the production telemetry transport (privacy review,
 * batching, real metric pipeline) is the blocking telemetry sub-issue listed in
 * the PR body. Do not add network calls or persistence here without that
 * sub-issue landing first.
 */
export function trackEvent(name: string, payload?: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.info("[pawwork:event]", name, payload ?? {})
}
