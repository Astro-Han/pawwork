// Module-level thumbnail cache for path-backed attachment chips. Chips remount
// on every keystroke (prompt.set clones parts), so previews must resolve from
// here instead of a per-mount createResource: a pending Resource read under the
// router-level Suspense boundary detaches and re-inserts the whole route
// content, dropping editor focus (#1247 regression).

type PreviewLoader = (path: string, mime: string) => Promise<string | null>

// Previews are whole-file data URLs (up to MAX_ATTACHMENT_BYTES base64-encoded),
// so the value cache must stay small.
const MAX_RESOLVED_ENTRIES = 32

const inflight = new Map<string, Promise<string | null>>()
const resolved = new Map<string, string | null>()

const cacheKey = (path: string, mime: string) => `${mime}:${path}`

/** Synchronous cache read; undefined = never loaded, null = load failed. */
export function cachedPreview(path: string, mime: string): string | null | undefined {
  const key = cacheKey(path, mime)
  if (!resolved.has(key)) return undefined
  // Map iteration order is insertion order; re-insert to mark as recently used.
  const value = resolved.get(key) ?? null
  resolved.delete(key)
  resolved.set(key, value)
  return value
}

export function loadPreviewCached(path: string, mime: string, loader: PreviewLoader): Promise<string | null> {
  const key = cacheKey(path, mime)
  if (resolved.has(key)) return Promise.resolve(cachedPreview(path, mime) ?? null)
  const pending = inflight.get(key)
  if (pending) return pending
  const promise = loader(path, mime)
    .catch(() => null)
    .then((result) => {
      inflight.delete(key)
      resolved.set(key, result)
      while (resolved.size > MAX_RESOLVED_ENTRIES) {
        const oldest = resolved.keys().next().value
        if (oldest === undefined) break
        resolved.delete(oldest)
      }
      return result
    })
  inflight.set(key, promise)
  return promise
}

/**
 * Drop cached failures for a path (any mime). Called when the user re-adds a
 * file through an entry point, where the desktop approval is fresh again —
 * without this, a preview that failed once (e.g. expired approval after
 * undo/fork restore) stays negative-cached for the whole session.
 */
export function invalidateFailedPreview(path: string) {
  const suffix = `:${path}`
  for (const [key, value] of resolved) {
    if (value === null && key.endsWith(suffix)) resolved.delete(key)
  }
}

/** Testing-only: reset module state between test runs. */
export const _previewCacheTesting = {
  reset: () => {
    inflight.clear()
    resolved.clear()
  },
}
