import path from "node:path"

// Keep image entries in sync with packages/util/src/file-extensions.ts::IMAGE_EXTS.
export const MIME_BY_EXTENSION = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])

export function attachmentPathMime(filepath: string, extname = path.extname) {
  const suffix = extname(filepath).slice(1).toLowerCase()
  return MIME_BY_EXTENSION.get(suffix)
}
