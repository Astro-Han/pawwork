/**
 * Run a disconnect attempt and report the outcome as data instead of throwing.
 * The dialog uses this to stay the source of truth for what it shows: on `ok` it
 * closes; on failure it keeps itself open with the message, so the credential's
 * fate is unambiguous — a thrown disconnect (e.g. a locked OS keyring) means the
 * token is still saved, and the user can retry or cancel rather than be left with
 * a silently-closed dialog that may or may not have revoked access.
 */
export async function attemptDisconnect(
  disconnect: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await disconnect()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
