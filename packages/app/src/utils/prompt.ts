import type { FilePart, Part, TextPart } from "@opencode-ai/sdk/v2"
import { deriveCommandInvocation } from "@opencode-ai/ui/lib/command-invocation"
import type { FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function textPartValue(parts: Part[]) {
  const candidates = parts
    .filter((part): part is TextPart => part.type === "text")
    .filter((part) => !part.synthetic && !part.ignored)
  return candidates.reduce((best: TextPart | undefined, part) => {
    if (!best) return part
    if (part.text.length > best.text.length) return part
    return best
  }, undefined)
}

/**
 * Extract prompt content from message parts for restoring into the prompt input.
 * This is used by undo to restore the original user prompt.
 */
export function extractPromptFromParts(parts: Part[], opts?: { directory?: string; attachmentName?: string }): Prompt {
  const attachmentName = opts?.attachmentName ?? "attachment"
  const invocation = deriveCommandInvocation(parts)
  if (invocation) {
    const restoreText = invocation.restoreText
    const out: Prompt = [{ type: "text", content: restoreText, start: 0, end: restoreText.length }]
    for (const part of parts) {
      if (part.type !== "file") continue
      const filePart = part as FilePart
      if (!filePart.url.startsWith("data:")) continue
      if (invocation.suppressFilePartIds.includes(filePart.id)) continue
      const image: ImageAttachmentPart = {
        type: "image",
        id: filePart.id,
        filename: filePart.filename ?? attachmentName,
        mime: filePart.mime,
        dataUrl: filePart.url,
      }
      out.push(image)
    }
    return out
  }

  const textPart = textPartValue(parts)
  const text = textPart?.text ?? ""
  const directory = opts?.directory

  const toRelative = (path: string) => {
    if (!directory) return path

    const prefix = directory.endsWith("/") ? directory : directory + "/"
    if (path.startsWith(prefix)) return path.slice(prefix.length)

    if (path.startsWith(directory)) {
      const next = path.slice(directory.length)
      if (next.startsWith("/")) return next.slice(1)
      return next
    }

    return path
  }

  const inline: Inline[] = []
  const images: ImageAttachmentPart[] = []

  for (const part of parts) {
    if (part.type === "file") {
      const filePart = part as FilePart
      const sourceText = filePart.source?.text
      if (sourceText) {
        const value = sourceText.value
        const start = sourceText.start
        const end = sourceText.end
        let path = value
        if (value.startsWith("@")) path = value.slice(1)
        if (!value.startsWith("@") && filePart.source && "path" in filePart.source) {
          path = filePart.source.path
        }
        inline.push({
          type: "file",
          start,
          end,
          value,
          path: toRelative(path),
          selection: selectionFromFileUrl(filePart.url),
        })
        continue
      }

      if (filePart.url.startsWith("data:")) {
        images.push({
          type: "image",
          id: filePart.id,
          filename: filePart.filename ?? attachmentName,
          mime: filePart.mime,
          dataUrl: filePart.url,
        })
      }
    }

    // PawWork issue #239: AgentPart records from history are intentionally NOT
    // converted to inline agent pills. The original `@<name>` substring is
    // already in the surrounding text part, so it restores as plain text.
    // This single point also defuses buildRequestParts (no AgentPartInput
    // submitted) and renderEditor (no pill).
  }

  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  const result: Prompt = []
  let position = 0
  let cursor = 0

  const pushText = (content: string) => {
    if (!content) return
    result.push({
      type: "text",
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushFile = (item: Extract<Inline, { type: "file" }>) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    result.push(attachment)
    position += content.length
  }

  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    if (start === -1) continue
    const end = mismatch ? start + expected.length : item.end

    pushText(text.slice(cursor, start))

    if (item.type === "file") pushFile(item)

    cursor = end
  }

  pushText(text.slice(cursor))

  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  if (images.length === 0) return result
  return [...result, ...images]
}
