import path from "path"

function sliceAfterMatch(filePath: string, searchRoots: string[]) {
  const normalizedPath = filePath.replaceAll("\\", "/")
  const comparablePath = normalizedPath.toLowerCase()
  const normalizedRoots = searchRoots
    .map((root) => root.replaceAll("\\", "/").replace(/\/+$/, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)

  for (const searchRoot of normalizedRoots) {
    const needle = `${searchRoot}/`
    const index = comparablePath.indexOf(needle.toLowerCase())
    if (index === -1) continue
    return normalizedPath.slice(index + needle.length).replace(/^\/+/, "")
  }
}

export function configEntryNameFromPath(filePath: string, searchRoots: string[]) {
  const candidate = sliceAfterMatch(filePath, searchRoots) ?? path.basename(filePath)
  const ext = path.extname(candidate)
  return ext.length ? candidate.slice(0, -ext.length) : candidate
}
