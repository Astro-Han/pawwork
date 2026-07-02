import fs from "fs/promises"
import path from "path"

/**
 * How long an entry in the agent scratch directory (`Global.Path.tmp`) may sit
 * untouched before a startup sweep removes it. The scratch dir holds the agent's
 * `${tmp}` shell artifacts (PR drafts, patches, debug output) which are
 * write-and-forget, so a one-day window is safe: anything an active session
 * wrote recently keeps a fresh timestamp and survives.
 */
export const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Whether every node in an entry's subtree is older than `cutoff`, following no
 * symlinks. Short-circuits on the first node at or after `cutoff` — one recent
 * file keeps the whole entry — so a large kept tree (a cloned repo, a build dir)
 * is not walked in full on startup. Freshness uses `max(mtimeMs, ctimeMs)` so a
 * file whose mtime was restored to the past (`cp -p`, unzip) but was actually
 * just created still reads as recent. A node that cannot be stat-ed is treated
 * as fresh (returns `false`) so an uncertain entry is left in place; a future
 * timestamp is likewise recent and keeps the entry.
 */
async function isSubtreeStale(entry: string, cutoff: number): Promise<boolean> {
  let stat
  try {
    stat = await fs.lstat(entry)
  } catch {
    return false
  }
  if (Math.max(stat.mtimeMs, stat.ctimeMs) >= cutoff) return false
  if (stat.isDirectory()) {
    let children: string[]
    try {
      children = await fs.readdir(entry)
    } catch {
      return false
    }
    for (const child of children) {
      if (!(await isSubtreeStale(path.join(entry, child), cutoff))) return false
    }
  }
  return true
}

/**
 * Remove scratch entries whose whole subtree has gone untouched for longer than
 * `maxAgeMs`. Best-effort and idempotent: a missing directory is a no-op and a
 * per-entry removal failure is swallowed so it never blocks startup. This is a
 * lock-free cleanup for per-command `${tmp}` artifacts: recent writes keep an
 * entry fresh, but a process that starts writing into an already-stale subtree
 * after the freshness check can still race with removal. A cooperative
 * ownership/liveness protocol is intentionally out of scope for this P3 cleanup.
 */
export async function sweepScratch(options: { dir: string; now: number; maxAgeMs: number }): Promise<void> {
  const { dir, now, maxAgeMs } = options
  const cutoff = now - maxAgeMs
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const entry = path.join(dir, name)
    if (!(await isSubtreeStale(entry, cutoff))) continue
    // maxRetries rides out transient Windows locks (AV / indexer) on otherwise
    // stale entries; force ignores a concurrent delete.
    await fs.rm(entry, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }).catch(() => {})
  }
}
