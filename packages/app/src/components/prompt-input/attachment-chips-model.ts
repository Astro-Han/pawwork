import type { FloatingAttachment } from "@/context/prompt"

export function formatFileSize(size: number | undefined) {
  if (size === undefined || !Number.isFinite(size) || size < 0) return ""
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${Number.isInteger(mb) ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

export interface AttachmentChipModel {
  id: string
  kind: "image" | "file"
  filename: string
  /** Absolute path for path-backed chips; legacy data-URL parts have none. */
  path?: string
  mime?: string
  sizeText: string
  tooltip: string
  /** Display source for legacy data-URL parts (also the submit payload). */
  legacyDataUrl?: string
}

export function attachmentChipModel(part: FloatingAttachment): AttachmentChipModel {
  const isImage = part.mime?.startsWith("image/") === true
  const kind = isImage ? "image" : "file"
  if (part.type === "image") {
    return {
      id: part.id,
      kind,
      filename: part.filename,
      mime: part.mime,
      sizeText: "",
      tooltip: part.filename,
      legacyDataUrl: isImage ? part.dataUrl : undefined,
    }
  }
  const sizeText = formatFileSize(part.size)
  return {
    id: part.id,
    kind,
    filename: part.filename,
    path: part.path,
    mime: part.mime,
    sizeText,
    tooltip: sizeText ? `${part.path}\n${sizeText}` : part.path,
  }
}
