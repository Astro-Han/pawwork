import path from "path"

// Strips a known prefix anchored at the START of an already-relative path.
// Callers pass the path relative to the directory they scanned (e.g.
// `path.relative(dir, item)`), so the prefix match is anchored. Matching a
// prefix anywhere in an absolute path used to mis-key entries whose parent or
// home segments coincidentally contained a prefix name — e.g. a user under
// `/Users/agent/` leaked the intervening path into the agent key (see #28359 /
// upstream #25713). Matching stays case-insensitive and roots are normalized to
// preserve PawWork's prior behavior.
function stripPrefix(relativePath: string, prefixes: string[]) {
  const normalizedPath = relativePath.replaceAll("\\", "/")
  const comparablePath = normalizedPath.toLowerCase()
  const normalizedPrefixes = prefixes
    .map((prefix) => prefix.replaceAll("\\", "/").replace(/\/+$/, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)

  for (const prefix of normalizedPrefixes) {
    const needle = `${prefix}/`
    if (!comparablePath.startsWith(needle.toLowerCase())) continue
    return normalizedPath.slice(needle.length).replace(/^\/+/, "")
  }
}

export function configEntryNameFromPath(relativePath: string, prefixes: string[]) {
  const candidate = stripPrefix(relativePath, prefixes) ?? path.basename(relativePath)
  const ext = path.extname(candidate)
  return ext.length ? candidate.slice(0, -ext.length) : candidate
}
