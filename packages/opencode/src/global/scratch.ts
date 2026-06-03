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
 * Newest modify/change time across an entry's subtree, following no symlinks.
 * Uses `max(mtimeMs, ctimeMs)` so a file whose mtime was restored to the past
 * (`cp -p`, unzip) but was actually just created still reads as recent. Returns
 * `Infinity` when anything cannot be stat-ed, so an uncertain entry is treated
 * as fresh and left in place; a future timestamp is likewise large and kept.
 */
async function newestTimestamp(entry: string): Promise<number> {
  let stat
  try {
    stat = await fs.lstat(entry)
  } catch {
    return Infinity
  }
  let newest = Math.max(stat.mtimeMs, stat.ctimeMs)
  if (stat.isDirectory()) {
    let children: string[]
    try {
      children = await fs.readdir(entry)
    } catch {
      return Infinity
    }
    for (const child of children) {
      newest = Math.max(newest, await newestTimestamp(path.join(entry, child)))
    }
  }
  return newest
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
    if ((await newestTimestamp(entry)) >= cutoff) continue
    await fs.rm(entry, { recursive: true, force: true }).catch(() => {})
  }
}
