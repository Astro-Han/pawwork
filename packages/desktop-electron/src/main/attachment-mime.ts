import path from "node:path"
import { IMAGE_EXTS } from "@opencode-ai/util/file-extensions"

export const MIME_BY_EXTENSION = new Map([
  ...IMAGE_EXTS,
  ["pdf", "application/pdf"],
])

export function attachmentPathMime(filepath: string, extname = path.extname) {
  const suffix = extname(filepath).slice(1).toLowerCase()
  return MIME_BY_EXTENSION.get(suffix)
}
