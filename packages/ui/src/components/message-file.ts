import type { FilePart } from "@opencode-ai/sdk/v2"

export function attached(part: FilePart) {
  return part.url.startsWith("data:")
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

/**
 * Floating composer chips: source-less path parts tagged metadata.attachment
 * at submit. Context-item parts share the wire shape but carry no tag and
 * stay out of the bubble's attachment row.
 */
export function chip(part: FilePart) {
  if (attached(part) || inline(part)) return false
  return (part as FilePart & { metadata?: { attachment?: unknown } }).metadata?.attachment === true
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
