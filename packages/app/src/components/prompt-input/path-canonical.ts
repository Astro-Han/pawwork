/**
 * Path canonicalization helpers shared across prompt-input modules.
 *
 * These functions are intentionally pure (no I/O, no platform detection) so
 * they work identically in the renderer process, tests, and future portable
 * draft owners.
 */

/** Returns true for POSIX absolute, Windows drive, or UNC paths. */
export function isAbsoluteLike(path: string): boolean {
  if (path.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return true
  if (path.startsWith("\\\\") || path.startsWith("//")) return true
  return false
}

/**
 * Returns an absolute path for `path` relative to `sourceFilesystemDirectory`.
 * If `path` is already absolute-like, it is returned unchanged.
 * The join always uses a forward slash separator between dir and relative path
 * (matching the original inline `absolute()` in build-request-parts.ts).
 */
export function toAbsoluteFilePath(sourceFilesystemDirectory: string, path: string): string {
  if (isAbsoluteLike(path)) return path
  const trimmedDir = sourceFilesystemDirectory.replace(/[\\/]+$/, "")
  return `${trimmedDir}/${path}`
}

/**
 * Returns true iff `absolutePath` is the same as, or inside, `sourceFilesystemDirectory`.
 *
 * Comparison strategy:
 * - Backslashes are normalized to forward slashes for comparison only (inputs unchanged).
 * - Case-insensitive only when `sourceFilesystemDirectory` looks like a Windows root
 *   (drive letter `C:/...` or UNC `\\...`). POSIX comparison is case-sensitive.
 */
export function isUnderDirectory(absolutePath: string, sourceFilesystemDirectory: string): boolean {
  const isWindowsRoot =
    /^[A-Za-z]:[\\/]/.test(sourceFilesystemDirectory) ||
    /^[A-Za-z]:$/.test(sourceFilesystemDirectory) ||
    sourceFilesystemDirectory.startsWith("\\\\")

  // Normalize backslashes for comparison only
  const normalize = (p: string) => p.replace(/\\/g, "/")
  let normPath = normalize(absolutePath)
  let normDir = normalize(sourceFilesystemDirectory)

  if (isWindowsRoot) {
    normPath = normPath.toLowerCase()
    normDir = normDir.toLowerCase()
  }

  if (normPath === normDir) return true
  // Must start with dir + "/" or dir + "\"  (after normalization, always "/")
  return normPath.startsWith(normDir + "/")
}

/**
 * Returns a compact display label for a file path.
 *
 * - If `sourceFilesystemDirectory` is provided and the path is under it:
 *   strips the directory prefix and leading separator.
 * - Otherwise: returns the basename (last `/` or `\` segment).
 * - If the result exceeds `maxSegmentLen` (default 24), truncates the middle
 *   with an ellipsis `…`, keeping the extension intact.
 *
 * Example: `very-long-filename-here.tsx` with maxSegmentLen=18 → `very-long…here.tsx`
 */
export function compactFilePath(
  absolutePath: string,
  sourceFilesystemDirectory?: string,
  maxSegmentLen = 24,
): string {
  let label: string

  if (sourceFilesystemDirectory !== undefined && isUnderDirectory(absolutePath, sourceFilesystemDirectory)) {
    // Strip directory prefix and any leading separator
    const trimmedDir = sourceFilesystemDirectory.replace(/[\\/]+$/, "")
    label = absolutePath.slice(trimmedDir.length).replace(/^[\\/]+/, "")
  } else {
    // Basename: last segment after / or \
    const lastSep = Math.max(absolutePath.lastIndexOf("/"), absolutePath.lastIndexOf("\\"))
    label = lastSep >= 0 ? absolutePath.slice(lastSep + 1) : absolutePath
  }

  if (label.length <= maxSegmentLen) return label

  // Truncate middle, keeping extension visible
  const dotIndex = label.lastIndexOf(".")
  const ext = dotIndex > 0 ? label.slice(dotIndex) : ""
  const stem = dotIndex > 0 ? label.slice(0, dotIndex) : label

  // Budget: maxSegmentLen minus ellipsis (1 char) minus ext
  const budget = maxSegmentLen - 1 - ext.length
  // Give 2/3 of the budget to the head so the tail shows the meaningful end
  const headLen = Math.ceil((budget * 2) / 3)
  const tailLen = budget - headLen

  const head = stem.slice(0, headLen)
  const tail = tailLen > 0 ? stem.slice(-tailLen) : ""
  return `${head}…${tail}${ext}`
}
